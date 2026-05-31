import { BadRequestException, Body, Controller, Get, Injectable, Logger, OnApplicationBootstrap, Post, Query } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule, AuditService } from '../../common/audit.service';
import { currentWorkspaceId, tenantStore } from '../../common/tenant';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { ingestObsidianVault, obsidianVaultPath, type ObsidianResult } from './obsidian';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const DEFAULT_WS = '00000000-0000-0000-0000-0000000000ff';

// Shared run-state so the manual trigger and the daily sync never overlap.
const obsidianState: { running: boolean; lastRun?: string; lastResult?: ObsidianResult } = { running: false };

async function runObsidianSync(prisma: PrismaService, workspaceId: string, cap?: number): Promise<ObsidianResult | { skipped: string }> {
  const vaultPath = obsidianVaultPath();
  if (!vaultPath) return { skipped: 'OBSIDIAN_VAULT_PATH not set' };
  if (obsidianState.running) return { skipped: 'already running' };
  obsidianState.running = true;
  try {
    // Bind the workspace so tenant-scoped documents/knowledge_chunks writes are stamped.
    const result = await tenantStore.run({ workspaceId }, () =>
      ingestObsidianVault(prisma, { vaultPath, workspaceId, agentUrl: AGENT_URL, internalToken: INTERNAL_TOKEN, cap }),
    );
    obsidianState.lastResult = result;
    obsidianState.lastRun = new Date().toISOString();
    return result;
  } finally {
    obsidianState.running = false;
  }
}

// SSRF guard: reject loopback / private / link-local / unique-local / metadata
// targets so a URL ingest can't reach internal services (agent, postgres, cloud
// metadata at 169.254.169.254) from inside the container network.
function isPrivateAddr(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local + cloud metadata
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  if (v === 6) {
    const lc = ip.toLowerCase();
    return lc === '::1' || lc === '::' || lc.startsWith('fe80') || lc.startsWith('fc') || lc.startsWith('fd') || lc.startsWith('::ffff:');
  }
  return true; // unknown → treat as unsafe
}

async function assertPublicUrl(parsed: URL): Promise<void> {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    throw new BadRequestException('Refusing to fetch an internal/private host.');
  }
  // Resolve every address the host maps to; reject if ANY is private.
  let addrs: { address: string }[] = [];
  if (isIP(host)) addrs = [{ address: host }];
  else {
    try {
      addrs = await lookup(host, { all: true });
    } catch {
      throw new BadRequestException('Could not resolve the URL host.');
    }
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddr(a.address))) {
    throw new BadRequestException('Refusing to fetch an internal/private address.');
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Minimal Knowledge Base (M4). Text upload → agent ingest; search → agent.
@Controller()
class KnowledgeController {
  private readonly logger = new Logger(KnowledgeController.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('documents')
  list(@Query() q: any) {
    const where: any = {};
    if (q.customerId) where.customer_id = q.customerId;
    if (q.projectId) where.project_id = q.projectId;
    return this.prisma.documents.findMany({ where, orderBy: { created_at: 'desc' }, take: 100 });
  }

  @Roles('consultant')
  @Post('documents')
  async upload(@Body() body: { title: string; text: string; customerId?: string; projectId?: string; tags?: string[] }, @CurrentUser() user: AuthUser) {
    const doc = await this.prisma.documents.create({
      data: {
        title: body.title,
        source_type: 'upload',
        mime_type: 'text/plain',
        customer_id: body.customerId,
        project_id: body.projectId,
        uploaded_by_id: user.id,
        status: 'processing',
        size_bytes: body.text?.length ?? 0,
      },
    });
    try {
      const res = await fetch(`${AGENT_URL}/v1/rag/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({ document_id: doc.id, title: body.title, text: body.text, metadata: { workspace_id: currentWorkspaceId() ?? null, customer_id: body.customerId ?? null, project_id: body.projectId ?? null, tags: body.tags ?? [] } }),
      });
      const data: any = await res.json();
      const chunks: any[] = data.chunks ?? [];
      for (const c of chunks) {
        await this.prisma.knowledge_chunks.create({
          data: {
            document_id: doc.id,
            ordinal: c.ordinal,
            text: c.text,
            token_count: c.token_count ?? null,
            qdrant_point_id: c.qdrant_point_id,
            embedding_model: data.embedding_model ?? 'stub',
            customer_id: body.customerId,
            project_id: body.projectId,
            metadata: { workspace_id: currentWorkspaceId(), tags: body.tags ?? [] },
          },
        });
      }
      await this.prisma.documents.update({ where: { id: doc.id }, data: { status: 'indexed', chunk_count: chunks.length, embedding_model: data.embedding_model ?? 'stub', indexed_at: new Date() } });
      await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'index', entityType: 'documents', entityId: doc.id, summary: `Indexed ${chunks.length} chunks` });
    } catch (e) {
      await this.prisma.documents.update({ where: { id: doc.id }, data: { status: 'failed' } });
    }
    return { documentId: doc.id, status: 'ok' };
  }

  @Roles('manager')
  @Post('knowledge/ingest-url')
  async ingestUrl(@Body() body: { url: string; title?: string; tags?: string[] }, @CurrentUser() user: AuthUser) {
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      throw new BadRequestException('Invalid URL.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BadRequestException('Only http(s) URLs can be ingested.');
    await assertPublicUrl(parsed);

    const fetched = await fetch(parsed.toString(), { headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' }, redirect: 'error' });
    if (!fetched.ok) throw new BadRequestException(`URL fetch failed: ${fetched.status}`);
    const raw = await fetched.text();
    const text = htmlToText(raw);
    if (!text || text.length < 20) throw new BadRequestException('Fetched URL did not contain enough readable text.');
    const title = body.title?.trim() || parsed.hostname + parsed.pathname;

    const doc = await this.prisma.documents.create({
      data: {
        title,
        source_type: 'url',
        mime_type: fetched.headers.get('content-type')?.slice(0, 120) ?? 'text/html',
        external_ref: parsed.toString(),
        uploaded_by_id: user.id,
        status: 'processing',
        size_bytes: text.length,
        metadata: { source_url: parsed.toString(), tags: body.tags ?? [] },
      },
    });

    try {
      const res = await fetch(`${AGENT_URL}/v1/rag/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({
          document_id: doc.id,
          title,
          text,
          metadata: { workspace_id: currentWorkspaceId() ?? null, title, source_url: parsed.toString(), type: 'url', tags: body.tags ?? [] },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: any = await res.json();
      const chunks: any[] = data.chunks ?? [];
      for (const c of chunks) {
        await this.prisma.knowledge_chunks.create({
          data: {
            document_id: doc.id,
            ordinal: c.ordinal,
            text: c.text,
            token_count: c.token_count ?? null,
            qdrant_point_id: c.qdrant_point_id,
            embedding_model: data.embedding_model ?? 'stub',
            metadata: { workspace_id: currentWorkspaceId(), source_url: parsed.toString(), type: 'url', tags: body.tags ?? [] },
          },
        });
      }
      await this.prisma.documents.update({ where: { id: doc.id }, data: { status: 'indexed', chunk_count: chunks.length, embedding_model: data.embedding_model ?? 'stub', indexed_at: new Date() } });
      await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'index', entityType: 'documents', entityId: doc.id, summary: `Indexed URL ${parsed.toString()} (${chunks.length} chunks)` });
      return { ingested: true, documentId: doc.id, chunks: chunks.length };
    } catch (e) {
      await this.prisma.documents.update({ where: { id: doc.id }, data: { status: 'failed' } });
      throw new BadRequestException(`URL ingestion failed: ${(e as Error).message}`);
    }
  }

  @Post('knowledge/search')
  async search(@Body() body: { query: string; topK?: number; filter?: any }) {
    const res = await fetch(`${AGENT_URL}/v1/rag/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({ query: body.query, top_k: body.topK ?? 5, filter: { ...(body.filter ?? {}), workspace_id: currentWorkspaceId() ?? null } }),
    });
    const data: any = await res.json();
    // The agent returns title/text from the Qdrant payload directly; fall back to
    // postgres only when a field is missing.
    const results = [] as any[];
    for (const r of data.results ?? []) {
      let title = r.title as string | undefined;
      let snippet = (r.text as string | undefined) ?? '';
      if (!title || !snippet) {
        const chunk = await this.prisma.knowledge_chunks.findFirst({ where: { qdrant_point_id: r.point_id ?? r.chunk_id }, include: { document: { select: { title: true } } } });
        title = title ?? chunk?.document?.title;
        snippet = snippet || (chunk?.text ?? '');
      }
      results.push({ chunkId: r.chunk_id, documentId: r.document_id, title: title ?? 'untitled', score: r.score, snippet: snippet.slice(0, 300) });
    }
    return { results };
  }

  // ── Obsidian vault (mounted read-only at OBSIDIAN_VAULT_PATH) ──────────────
  @Get('knowledge/obsidian/status')
  async obsidianStatus() {
    const vaultPath = obsidianVaultPath();
    const indexed = await this.prisma.documents.count({ where: { source_type: 'obsidian', status: 'indexed' } });
    return { configured: !!vaultPath, vaultPath: vaultPath ? '/vault (mounted)' : null, indexed, running: obsidianState.running, lastRun: obsidianState.lastRun ?? null, lastResult: obsidianState.lastResult ?? null };
  }

  // Trigger a full vault sweep. Runs in the background (5k+ notes would exceed an
  // HTTP timeout) — the UI polls /obsidian/status for progress. Hash-skips unchanged notes.
  @Roles('manager')
  @Post('knowledge/obsidian/sync')
  async obsidianSync(@Body() body: { cap?: number }) {
    if (!obsidianVaultPath()) {
      throw new BadRequestException('Obsidian vault not mounted. Set OBSIDIAN_VAULT_HOST_PATH in .env and restart the stack.');
    }
    if (obsidianState.running) return { started: false, running: true };
    const ws = currentWorkspaceId() ?? DEFAULT_WS;
    // Fire-and-forget; runObsidianSync binds its own workspace context.
    void runObsidianSync(this.prisma, ws, body?.cap).then((r) => this.logger.log(`[obsidian] sync done: ${JSON.stringify(r)}`)).catch((e) => this.logger.error(`[obsidian] sync failed: ${e.message}`));
    return { started: true };
  }
}

// Daily background re-sync of the Obsidian vault (gated by ENABLE_OBSIDIAN_SYNC).
// Lives in the API container where the vault is mounted; reuses the hash-skip sweep.
@Injectable()
class ObsidianSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger('ObsidianSync');
  private timer?: NodeJS.Timeout;
  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    if (process.env.ENABLE_OBSIDIAN_SYNC !== 'true' || !obsidianVaultPath()) return;
    const day = 24 * 60 * 60 * 1000;
    const tick = () => runObsidianSync(this.prisma, DEFAULT_WS).then((r) => this.logger.log(`[obsidian] daily sync: ${JSON.stringify(r)}`)).catch((e) => this.logger.error(`[obsidian] daily sync failed: ${e.message}`));
    setTimeout(tick, 30_000); // initial sweep ~30s after boot
    this.timer = setInterval(tick, day);
    this.logger.log('Obsidian daily sync enabled.');
  }
}

@Module({ imports: [AuditModule], controllers: [KnowledgeController], providers: [ObsidianSyncService] })
export class KnowledgeModule {}
