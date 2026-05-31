import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ── Obsidian vault → workspace-scoped RAG ingester ────────────────────────────
// Walks a mounted Obsidian vault (read-only), parses each markdown note
// (frontmatter, #tags, [[wikilinks]]), derives customer/project from the path
// (the obsidian-azure-devops plugin lays notes out as
// <vault>/<Org>/<Customer>/<Project>/Work Items/...), then ingests via the agent
// RAG endpoint. Unchanged notes are skipped via a SHA-256 content hash so daily
// re-syncs only touch new/edited notes. Everything stays local (stub/Ollama).

const EXCLUDE_DIR = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
const MAX_BYTES = 256 * 1024; // skip oversized blobs (e.g. excalidraw/base64)

export interface ObsidianOptions {
  vaultPath: string;
  workspaceId?: string | null;
  agentUrl: string;
  internalToken: string;
  cap?: number;
}

export interface ObsidianResult {
  scanned: number;
  ingested: number;
  skipped: number;
  errors: number;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIR.has(e.name)) continue;
      await walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.excalidraw.md')) {
      out.push(path.join(dir, e.name));
    }
  }
}

function stripFrontmatter(raw: string): { body: string; fm: Record<string, string> } {
  const fm: Record<string, string> = {};
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const block = raw.slice(3, end).trim();
      for (const line of block.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m) fm[m[1].toLowerCase()] = m[2].trim();
      }
      return { body: raw.slice(end + 4), fm };
    }
  }
  return { body: raw, fm };
}

// Normalize note content for embedding: keep wikilink/tag TEXT, drop markup noise.
function cleanText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/!\[\[([^\]]+)\]\]/g, ' ') // embedded attachments
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[link|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[link]] → link
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/[*_>#`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTags(body: string, fm: Record<string, string>): string[] {
  const tags = new Set<string>();
  const fmTags = fm['tags'] ?? fm['tag'];
  if (fmTags) fmTags.replace(/[\[\]"']/g, '').split(/[,\s]+/).filter(Boolean).forEach((t) => tags.add(t.replace(/^#/, '')));
  for (const m of body.matchAll(/(?:^|\s)#([A-Za-z0-9/_-]{2,40})/g)) tags.add(m[1]);
  return [...tags].slice(0, 25);
}

// Derive {customer, project} from the relative path when it follows the
// azure-devops plugin layout; otherwise use the top folder as the "area".
function pathMeta(relPath: string): { customer?: string; project?: string; area?: string } {
  const parts = relPath.split(path.sep).filter(Boolean);
  const adoIdx = parts.findIndex((p) => p === 'obsidian-azure-devops');
  if (adoIdx !== -1 && parts.length > adoIdx + 2) {
    return { customer: parts[adoIdx + 1], project: parts[adoIdx + 2] };
  }
  return { area: parts[0] };
}

async function ragIngest(opts: ObsidianOptions, payload: any): Promise<{ chunks: any[]; embeddingModel: string }> {
  const res = await fetch(`${opts.agentUrl}/v1/rag/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': opts.internalToken },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`rag ingest ${res.status}`);
  const data: any = await res.json();
  return { chunks: data.chunks ?? [], embeddingModel: data.embedding_model ?? 'stub' };
}

// One full sweep of the vault. `prisma` is the (tenant-bound) client; we upsert a
// documents row per note keyed by external_ref = "obsidian:<relpath>" and skip
// when the stored metadata.hash matches the current content hash.
export async function ingestObsidianVault(prisma: any, opts: ObsidianOptions): Promise<ObsidianResult> {
  const files: string[] = [];
  await walk(opts.vaultPath, files);
  const result: ObsidianResult = { scanned: 0, ingested: 0, skipped: 0, errors: 0 };
  const cap = opts.cap ?? Number.MAX_SAFE_INTEGER;

  for (const abs of files) {
    if (result.ingested >= cap) break;
    result.scanned++;
    try {
      const stat = await fs.stat(abs);
      if (stat.size === 0 || stat.size > MAX_BYTES) {
        result.skipped++;
        continue;
      }
      const raw = await fs.readFile(abs, 'utf8');
      const relPath = path.relative(opts.vaultPath, abs);
      const { body, fm } = stripFrontmatter(raw);
      const text = cleanText(body);
      if (text.length < 30) {
        result.skipped++;
        continue;
      }
      const hash = createHash('sha256').update(raw).digest('hex');
      const externalRef = `obsidian:${relPath}`;
      const existing = await prisma.documents.findFirst({ where: { external_ref: externalRef } });
      if (existing && (existing.metadata as any)?.hash === hash) {
        result.skipped++;
        continue;
      }

      const title = fm['title'] || fm['aliases'] || path.basename(abs, '.md');
      const meta = pathMeta(relPath);
      const tags = extractTags(body, fm);

      const doc = existing
        ? await prisma.documents.update({
            where: { id: existing.id },
            data: { title, status: 'processing', size_bytes: text.length, metadata: { ...(existing.metadata as any), hash, source: 'obsidian', path: relPath, ...meta, tags } },
          })
        : await prisma.documents.create({
            data: {
              title,
              source_type: 'obsidian',
              mime_type: 'text/markdown',
              external_ref: externalRef,
              status: 'processing',
              size_bytes: text.length,
              metadata: { hash, source: 'obsidian', path: relPath, ...meta, tags },
            },
          });

      const { chunks, embeddingModel } = await ragIngest(opts, {
        document_id: doc.id,
        title,
        text,
        metadata: { workspace_id: opts.workspaceId ?? null, title, type: 'obsidian', path: relPath, customer: meta.customer ?? null, project: meta.project ?? null, tags },
      });

      // Refresh chunk rows for this document (delete+recreate keeps re-sync simple)
      // so the search UI can hydrate titles/snippets from postgres.
      await prisma.knowledge_chunks.deleteMany({ where: { document_id: doc.id } });
      for (const c of chunks) {
        await prisma.knowledge_chunks.create({
          data: {
            document_id: doc.id,
            ordinal: c.ordinal,
            text: c.text,
            token_count: c.token_count ?? null,
            qdrant_point_id: c.qdrant_point_id,
            embedding_model: embeddingModel,
            metadata: { workspace_id: opts.workspaceId ?? null, type: 'obsidian', customer: meta.customer ?? null, project: meta.project ?? null, tags },
          },
        });
      }
      await prisma.documents.update({ where: { id: doc.id }, data: { status: 'indexed', chunk_count: chunks.length, embedding_model: embeddingModel, indexed_at: new Date() } });
      result.ingested++;
    } catch {
      result.errors++;
    }
  }
  return result;
}

export function obsidianVaultPath(): string | null {
  return process.env.OBSIDIAN_VAULT_PATH || null;
}
