// User-story governance: (1) score every story's description sufficiency,
// (2) detect whether customer documentation was delivered (attachments /
// doc-ish links / comment signals), (3) auto-generate the customer-deliverable
// training document (senior-consultant format: amaç/ön koşullar/mermaid süreç
// diyagramı/adım adım gerçek örnek/sık hatalar) and optionally announce it
// back on the ADO work item.

import { Body, Controller, Get, Logger, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, Roles, type AuthUser } from '../../auth/decorators';
import { AuditService } from '../../common/audit.service';
import { currentWorkspaceId, tenantStore } from '../../common/tenant';
import {
  devOpsAdapter, devopsConfigured, fetchAncestors, fetchChildItems, fetchUserStories, fetchWorkItemComments, fetchWorkItemFull,
} from '../../integrations/devops/devops.adapter';
import { renderDocHtml } from './doc-html';
import { PLATFORM_LABEL, buildEnvironmentContext, captureEnvironmentShots, type ShotSpec } from '../environments/environments.module';
import { getFileContent } from '../../integrations/github/github.adapter';
import { extractKeywords, findRelevantFiles, type RepoProfile } from './repo-profile';
import {
  assembleDocSections,
  buildCoverSection,
  buildSectionPrompt,
  buildSectionWarningStub,
  createDocSectionDefinitions,
  prepareFlowSection,
  resolveDocTemplateKind,
  type DocPlan,
  type DocScreenshot,
  type DocSectionDefinition,
  type GeneratedDocSection,
  type ObservedField,
} from './doc-sections';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const SHOTTER_URL = process.env.SHOTTER_URL ?? 'http://shotter:4600';

const DOC_SIGNAL_RE = /(dok[uü]man|documentation|training|e[ğg]itim|kullan[ıi]m k[ıi]lavuzu|user guide|\.(pdf|docx?|pptx?)\b|sharepoint\.com)/i;

interface DocBuildSectionProgress {
  key: string;
  index: number;
  label: string;
  status: 'done' | 'warn';
  model: string | null;
  startedAt: string;
  finishedAt: string;
}

interface DocBuildRun {
  runId: string;
  storyId: string;
  planDocId: string;
  phase: 'running' | 'done' | 'failed';
  section: number;
  sectionName: string | null;
  totalSections: number;
  startedAt: string;
  finishedAt: string | null;
  docId: string | null;
  error: string | null;
  sections: DocBuildSectionProgress[];
  delivered?: boolean;
  deliveryApprovalId?: string | null;
  deliveryStatus?: 'not_requested' | 'pending_approval' | 'error';
  deliveryError?: string | null;
  screenshots?: number;
  htmlPath?: string;
  pdfPath?: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseObservedFields(raw: unknown): ObservedField[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const cleaned = (value: unknown) => String(value ?? '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  let values: any[] = [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) values = parsed;
    } catch { /* headed/table output is preferred; parse below */ }
  }
  if (!values.length) {
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|?$/);
      if (!match) continue;
      const alan = cleaned(match[1]);
      const deger = cleaned(match[2]);
      if (!alan || !deger || /^(alan|field)$/i.test(alan) || /^[-:]+$/.test(alan) || /^[-:]+$/.test(deger)) continue;
      values.push({ alan, deger });
    }
  }
  const dedupe = new Set<string>();
  return values
    .map((value) => ({ alan: cleaned(value?.alan ?? value?.field), deger: cleaned(value?.deger ?? value?.value) }))
    .filter((value) => {
      if (!value.alan || !value.deger) return false;
      const key = value.alan.toLocaleLowerCase('tr-TR');
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    })
    .slice(0, 20);
}

function safeFilePart(value: unknown, fallback = 'dokuman'): string {
  const part = String(value ?? '')
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return part || fallback;
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headingOffset(markdown: string, heading: string, from = 0): number {
  const source = markdown.slice(Math.max(0, from));
  const match = new RegExp(`(^|\\n)${escapeRegExp(heading)}[ \\t]*(?=\\r?\\n|$)`, 'm').exec(source);
  if (!match) return -1;
  return Math.max(0, from) + match.index + (match[1] ? 1 : 0);
}

function replaceMarkdownSection(
  markdown: string,
  definition: DocSectionDefinition,
  nextDefinition: DocSectionDefinition | undefined,
  replacement: string,
): string | null {
  const startHeading = definition.requiredHeadings[0];
  if (!startHeading) return null;
  const start = headingOffset(markdown, startHeading);
  if (start < 0) return null;
  const end = nextDefinition?.requiredHeadings[0]
    ? headingOffset(markdown, nextDefinition.requiredHeadings[0], start + startHeading.length)
    : markdown.length;
  if (end < 0) return null;
  const before = markdown.slice(0, start).replace(/[ \\t]+$/g, '');
  const after = markdown.slice(end).replace(/^[\\r\\n]+/, '');
  return `${before}${before ? '\n\n' : ''}${replacement.trim()}${after ? `\n\n${after}` : ''}`.trim();
}

// Enrichment output parser. The model writes HEADED PLAIN TEXT rather than a
// JSON object nested inside the envelope's content string: asking for six
// fields of nested JSON made the small models drop the closing brace often
// enough to fail the whole call. Headings survive that class of error, and a
// missing section just yields an empty list.
export function parseEnrichment(raw: unknown): {
  description: string; acceptance: string[]; business_value: string;
  scope_out: string[]; open_questions: string[]; suggested_tasks: string[];
} | null {
  const clip = (v: any, n: number, len = 300) =>
    (Array.isArray(v) ? v : []).map((x: any) => String(x).trim().slice(0, len)).filter(Boolean).slice(0, n);

  // Tolerate a model that still returns the old JSON shape (object or string).
  const asJson = (() => {
    if (raw && typeof raw === 'object' && (raw as any).description) return raw as any;
    const s = String(raw ?? '');
    const start = s.indexOf('{');
    if (start < 0 || !/"description"\s*:/.test(s)) return null;
    for (const end of [s.lastIndexOf('}'), s.length - 1]) {
      if (end < start) continue;
      for (const candidate of [s.slice(start, end + 1), `${s.slice(start, end + 1)}}`]) {
        try {
          const p = JSON.parse(candidate);
          if (p?.description) return p;
        } catch { /* try next */ }
      }
    }
    return null;
  })();
  if (asJson) {
    return {
      description: String(asJson.description).trim().slice(0, 4000),
      acceptance: clip(asJson.acceptance, 8),
      business_value: String(asJson.business_value ?? '').trim().slice(0, 600),
      scope_out: clip(asJson.scope_out, 3),
      open_questions: clip(asJson.open_questions, 4),
      suggested_tasks: clip(asJson.suggested_tasks, 5, 200),
    };
  }

  const text = String(raw ?? '').trim();
  if (!text) return null;
  // Split on the ## headings; accept stray #/** decoration around them.
  const sections: Record<string, string> = {};
  let key = '';
  for (const line of text.split('\n')) {
    const h = line.match(/^\s*#{1,4}\s*\**\s*(ACIKLAMA|AÇIKLAMA|KABUL|DEGER|DEĞER|KAPSAM_DISI|KAPSAM DIŞI|SORULAR|GOREVLER|GÖREVLER)\b/i);
    if (h) {
      key = h[1].toUpperCase().replace(/[İIÇ]/g, (c) => ({ 'İ': 'I', 'I': 'I', 'Ç': 'C' } as any)[c] ?? c)
        .replace('AÇIKLAMA', 'ACIKLAMA').replace('DEĞER', 'DEGER').replace('KAPSAM DIŞI', 'KAPSAM_DISI').replace('GÖREVLER', 'GOREVLER');
      sections[key] = '';
      continue;
    }
    if (key) sections[key] += `${line}\n`;
  }
  const bullets = (k: string) =>
    (sections[k] ?? '').split('\n').map((l) => l.replace(/^\s*[-•*]\s*|^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);

  const description = (sections['ACIKLAMA'] ?? '').trim();
  if (!description) return null; // heading format not honoured → caller ladders down
  return {
    description: description.slice(0, 4000),
    acceptance: clip(bullets('KABUL'), 8),
    business_value: (sections['DEGER'] ?? '').trim().slice(0, 600),
    scope_out: clip(bullets('KAPSAM_DISI'), 3),
    open_questions: clip(bullets('SORULAR'), 4),
    suggested_tasks: clip(bullets('GOREVLER'), 5, 200),
  };
}

async function runAgent(req: unknown): Promise<any | null> {
  try {
    const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const tu = data?.token_usage ?? {};
    if (!tu.provider || tu.fallback || tu.stub) return null; // never accept degraded output
    return data;
  } catch {
    // Node fetch (undici) enforces a 300s headers timeout — a congested 70B can
    // exceed it. Treat as degraded; callers ladder down to the fast 8B.
    return null;
  }
}

@Controller()
export class StoryDocsController {
  private readonly logger = new Logger('StoryDocs');

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async docMetaReadinessChecks(meta: Record<string, unknown>): Promise<any[]> {
    const example = String(meta.ornek_kayit ?? '').trim();
    const audience = Array.isArray(meta.hedef_kitle)
      ? meta.hedef_kitle.map((value) => String(value ?? '').trim()).filter(Boolean).join(', ')
      : String(meta.hedef_kitle ?? '').trim();
    const audienceSpecific = Boolean(audience) && audience.toLocaleLowerCase('tr-TR') !== 'son kullanıcı';
    const drawioUrl = process.env.DRAWIO_URL?.trim();
    let drawioReachable = false;
    if (drawioUrl && meta.diagram !== false) {
      try {
        const response = await fetch(drawioUrl, { method: 'GET', signal: AbortSignal.timeout(2_000) });
        drawioReachable = response.status < 500;
        await response.body?.cancel().catch(() => {});
      } catch {
        drawioReachable = false;
      }
    }
    return [
      {
        key: 'ornek_kayit', ok: Boolean(example), blocker: false,
        message: example
          ? `Somut örnek kayıt hazır (${example.slice(0, 120)})`
          : 'Somut örnek kayıt yok — Ekranda ne görülür tabloları genel değerlerle üretilir',
        fix: example ? null : { label: 'Plan meta alanlarında örnek kayıt girin', url: '#doc-plan-meta' },
      },
      {
        key: 'hedef_kitle', ok: audienceSpecific, blocker: false,
        message: audienceSpecific
          ? `Hedef kitle özelleştirildi (${audience.slice(0, 120)})`
          : audience
            ? `Hedef kitle varsayılan (${audience}) — role göre özelleştirebilirsiniz`
            : 'Hedef kitle belirtilmedi — varsayılan Son kullanıcı kullanılacak',
        fix: audienceSpecific ? null : { label: 'Plan meta alanlarında hedef kitleyi özelleştirin', url: '#doc-plan-meta' },
      },
      {
        key: 'diagram', ok: drawioReachable, blocker: false,
        message: drawioReachable
          ? 'Draw.io süreç şeması servisi hazır'
          : 'Draw.io servisi yok veya erişilemiyor — süreç şeması mermaid ile üretilecek',
        fix: drawioReachable ? null : { label: 'Draw.io sidecar yapılandırmasını kontrol edin', url: '#doc-plan-meta' },
      },
    ];
  }

  // ── Audit: score descriptions + detect delivered documentation ─────────────
  @Roles('consultant')
  @Post('projects/:id/story-audit')
  async runStoryAudit(@Param('id') id: string) {
    const project = await (this.prisma as any).projects.findUnique({ where: { id } });
    if (!project?.devops_org || !project?.devops_project) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    if (!devopsConfigured()) return { ok: false, detail: 'ADO yapılandırılmamış' };

    const stories = await fetchUserStories(project.devops_org, String(project.devops_project), 60);
    if (!stories.length) return { ok: true, project: project.name, rows: [], detail: 'user story bulunamadı' };

    // Doc-delivery signals: attachment/hyperlink relations + comment keywords.
    const rows: any[] = [];
    for (const s of stories) {
      const rels = s.relations ?? [];
      const hasAttachment = rels.some((r) => /AttachedFile/i.test(r.rel));
      const hasDocLink = rels.some((r) => /Hyperlink/i.test(r.rel) && DOC_SIGNAL_RE.test(r.url));
      let commentSignal = false;
      if (!hasAttachment && !hasDocLink) {
        const comments = await fetchWorkItemComments(project.devops_org, s.id, 10).catch(() => []);
        commentSignal = comments.some((c) => DOC_SIGNAL_RE.test(c.text));
      }
      rows.push({
        id: s.id,
        title: s.title,
        state: s.state,
        assignee: s.assignee ?? null,
        descLen: (s.description ?? '').length,
        docDelivered: hasAttachment || hasDocLink || commentSignal,
        docSignal: hasAttachment ? 'ek dosya' : hasDocLink ? 'doküman linki' : commentSignal ? 'yorumda doküman' : null,
      });
    }

    // NIM scoring in batches of 12 — strict JSON array output.
    const pmResource = await this.prisma.ai_resources.findFirst({ where: { key: 'ai_delivery_pm', status: 'active' } });
    for (let i = 0; i < stories.length; i += 12) {
      const batch = stories.slice(i, i + 12);
      const listing = batch.map((s) => `ID ${s.id} | BAŞLIK: ${s.title}\nAÇIKLAMA: ${(s.description ?? '(boş)').slice(0, 600)}`).join('\n---\n');
      const data = await runAgent({
        run_id: `story-audit-${id.slice(0, 8)}-${i}-${Date.now()}`,
        workspace_id: project.workspace_id ?? undefined,
        ai_resource: {
          key: 'ai_story_auditor',
          name: 'AI Story Auditor',
          system_prompt:
            'Sen kıdemli bir D365 iş analisti değerlendiricisisin. Sana user story listesi verilecek. Her story için AÇIKLAMANIN yeterliliğini 0-100 puanla. ' +
            'Kriterler: iş amacı anlatılmış mı (25), kapsam/etkilenen süreç net mi (25), kabul kriteri/beklenen sonuç var mı (25), adım/örnek/veri detayı var mı (25). Boş açıklama = 0-10. ' +
            'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun; content alanına SADECE puan dizisini string olarak koy:\n' +
            '{"draft":{"kind":"note","subject":null,"content":"[{\\"id\\":123,\\"puan\\":45,\\"eksik\\":\\"tek cümle Türkçe eksik özeti\\"}]","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
            'JSON dışında hiçbir metin yazma.',
          provider: pmResource?.llm_provider ?? 'nvidia',
          model: pmResource?.llm_model ?? 'meta/llama-3.3-70b-instruct',
          temperature: 0.1,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: { id: `sa-${Date.now()}`, channel: 'manual', subject: 'User story kalite puanlama', body: listing, priority: 'normal', customer: null },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      });
      const content = String(data?.draft?.content ?? '');
      // Robust parse: try the whole array, else harvest individual {..."id"...}
      // objects (models sometimes wrap the array in prose or break commas).
      let scores: any[] = [];
      try {
        scores = JSON.parse(content.slice(content.indexOf('['), content.lastIndexOf(']') + 1));
      } catch {
        for (const m of content.match(/\{[^{}]*"id"[^{}]*\}/g) ?? []) {
          try { scores.push(JSON.parse(m)); } catch { /* skip fragment */ }
        }
        if (!scores.length) this.logger.warn(`story-audit batch ${i} parse failed — heuristic fallback`);
      }
      for (const sc of scores) {
        const row = rows.find((r) => String(r.id) === String(sc.id));
        if (row) { row.score = Math.max(0, Math.min(100, Number(sc.puan ?? sc.score ?? 0))); row.eksik = String(sc.eksik ?? sc.missing ?? '').slice(0, 200); }
      }
    }
    // Heuristic fallback for unscored rows (model/parse failure).
    for (const r of rows) {
      if (r.score == null) {
        r.score = r.descLen === 0 ? 0 : Math.min(70, Math.round(r.descLen / 12));
        r.eksik = r.eksik ?? (r.descLen === 0 ? 'Açıklama tamamen boş.' : 'Otomatik puan (model erişilemedi).');
      }
    }
    rows.sort((a, b) => a.score - b.score);

    const summary = {
      at: new Date().toISOString(),
      total: rows.length,
      avgScore: Math.round(rows.reduce((n, r) => n + r.score, 0) / rows.length),
      weak: rows.filter((r) => r.score < 50).length,
      docMissing: rows.filter((r) => !r.docDelivered).length,
      rows,
    };
    await (this.prisma as any).projects.update({
      where: { id },
      data: { metadata: { ...((project.metadata as any) ?? {}), story_audit: summary } },
    });
    await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'projects', entityId: id, summary: `Story audit: ${rows.length} story, ort. ${summary.avgScore}, ${summary.docMissing} doküman eksik` });
    return { ok: true, project: project.name, ...summary };
  }

  // ── Consultant flow phase 1: the DOCUMENTATION PLAN ────────────────────────
  // Before anything runs, the system states UPFRONT: which platform &
  // environment & user/session, which module & company, the method (section
  // walkthrough), the dataset (example records) and the exact screens it will
  // capture. The owner approves → phase 2 executes exactly this plan.
  @Roles('consultant')
  @Post('projects/:id/stories/:wid/doc-plan')
  async planDoc(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() reqBody?: { force?: boolean },
    @CurrentUser() user?: AuthUser,
  ) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };

    // ── HAZIRLIK ÖN ANALİZİ: yeterli içerik + ortam + oturum var mı? ─────────
    // Uygun değilse üretim YAPILMAZ — eksik ve doldurulacağı yer bildirilir.
    const children = await fetchChildItems(project.devops_org, story);
    const contentLen =
      (story.descriptionFull?.length ?? 0) + (story.acceptance?.length ?? 0) +
      children.reduce((n, c) => n + (c.descriptionFull?.length ?? 0) + c.title.length, 0);
    const adoEditUrl = `https://dev.azure.com/${project.devops_org}/${encodeURIComponent(String(project.devops_project))}/_workitems/edit/${story.id}`;
    // Full env rows once — reused for platform checks, plan targeting and the
    // company vocab (WS6: a project may span BC + F&SCM + a web app).
    const allEnvs = await (this.prisma as any).customer_environments.findMany({
      where: { customer_id: project.customer_id },
      select: { id: true, kind: true, name: true, base_url: true, status: true, metadata: true, project_id: true, ui_user: true, ui_session_encrypted: true, ui_session_saved_at: true },
    });
    const connected = allEnvs.filter((e: any) => e.status === 'connected');
    // Declared stack = repo kinds ∪ connected env kinds; the readiness check
    // and the screen vocabulary only cover platforms the project actually HAS.
    const stack = new Set<string>();
    for (const r of ((project.repos as any[]) ?? [])) stack.add(r.kind === 'bc-al' ? 'bc' : r.kind === 'fno-xpp' ? 'fno' : 'web');
    for (const e of connected) stack.add(e.kind);
    const connectedKinds = new Set(connected.map((e: any) => e.kind));
    const missingPlatforms = [...stack].filter((k) => !connectedKinds.has(k));
    const hasEnv = connected.length > 0;
    const hasSession = connected.some((e: any) => e.ui_session_encrypted || e.ui_user);
    const defaultPlanMeta = {
      hedef_kitle: 'Son kullanıcı',
      moduller: [...stack],
      ortam: [...new Set<string>(connected.map((e: any) => String(e.name ?? '').trim()).filter((name: string) => Boolean(name)))],
      ornek_kayit: '',
      surum: '1.0',
      hazirlayan: [user?.display_name?.trim() || 'DynamicsOps'],
      tur: 'egitim' as const,
      diagram: true,
    };
    const checks = [
      {
        key: 'icerik', ok: contentLen >= 150, blocker: true,
        message: contentLen >= 150
          ? `İçerik yeterli (${contentLen} kr — story + ${children.length} alt görev)`
          : `İçerik YETERSİZ (${contentLen} kr): story açıklaması/kabul kriterleri ve alt görev açıklamaları neredeyse boş — anlamlı doküman üretilemez.`,
        fix: contentLen >= 150 ? null : { label: `ADO'da #${story.id} açıklamasını ve kabul kriterlerini doldurun (alt görev açıklamaları da sayılır) — veya aşağıdan '✍️ AI ile doldur' kullanın`, url: adoEditUrl },
      },
      {
        key: 'ortam', ok: hasEnv && !missingPlatforms.length, blocker: false,
        message: !hasEnv
          ? 'Bağlı müşteri ortamı YOK — doküman genel kalır, ekran görüntüsü çekilemez.'
          : missingPlatforms.length
            ? `Bazı platformların ortamı bağlı değil: ${missingPlatforms.map((k) => PLATFORM_LABEL[k] ?? k).join(', ')} — bu platformların ekranları çekilemez.`
            : `Müşteri ortamı bağlı (${[...connectedKinds].map((k: any) => PLATFORM_LABEL[k] ?? k).join(', ')}) — doküman gerçek ortam bilgisiyle yazılır`,
        fix: hasEnv && !missingPlatforms.length ? null : { label: 'Müşteri Ortamları sayfasından eksik platform ortamını ekleyin', url: '/settings/environments' },
      },
      {
        key: 'oturum', ok: hasSession, blocker: false,
        message: hasSession ? 'Ekran görüntüsü oturumu hazır' : 'Oturum YOK — doküman ekran görüntüsüz üretilir.',
        fix: hasSession ? null : { label: `Oturum bağışlayın: node scripts/env-login.mjs ${connected[0]?.id ?? '<envId>'}`, url: '/settings/environments' },
      },
    ];
    checks.push(...await this.docMetaReadinessChecks(defaultPlanMeta));
    const blockers = checks.filter((c) => c.blocker && !c.ok);
    if (blockers.length && !reqBody?.force) {
      return {
        ok: true, ready: false, checks,
        story: { id: story.id, title: story.title },
        children: children.map((c) => ({ id: c.id, title: c.title, state: c.state })),
        detail: 'Ön analiz: doküman üretimi için içerik yetersiz — önce eksikleri doldurun (veya "yine de üret" ile zorlayın).',
      };
    }

    // Per-platform target environments (project-scoped rows win; session-
    // capable rows preferred). F&O documents against company CODES (cmp=),
    // BC against company display NAMES (web client ?company= parametresi).
    const envFor = (kind: string) =>
      connected.find((e: any) => e.kind === kind && e.project_id === project.id && (e.ui_session_encrypted || e.ui_user)) ??
      connected.find((e: any) => e.kind === kind && (e.ui_session_encrypted || e.ui_user)) ??
      connected.find((e: any) => e.kind === kind) ?? null;
    const fnoEnv = envFor('fno');
    const bcEnv = envFor('bc');
    const webEnv = envFor('web');
    const primary = fnoEnv ?? bcEnv ?? webEnv ?? null;
    const companyRows = ((fnoEnv?.metadata as any)?.companies ?? []).slice(0, 15);
    const companies = companyRows.map((c: any) => (c.id && c.name && c.id !== c.name ? `${c.id} (${c.name})` : (c.id ?? c.name)));
    const companyCodes = companyRows.map((c: any) => String(c.id ?? c.name ?? '')).filter(Boolean);
    const bcCompanies = (((bcEnv?.metadata as any)?.companies ?? []) as any[]).map((c: any) => String(c.name ?? c.id ?? '')).filter(Boolean).slice(0, 15);
    const sessionEnv = connected.find((e: any) => e.ui_session_encrypted) ?? null;
    const serviceEnv = connected.find((e: any) => e.ui_user) ?? null;
    const sessionInfo = sessionEnv
      ? { mode: 'donated_session', label: `Bağışlanmış oturum (${sessionEnv.ui_session_saved_at ? new Date(sessionEnv.ui_session_saved_at).toLocaleString('tr-TR') : '?'} — sahip onaylı, MFA uyumlu)` }
      : serviceEnv
        ? { mode: 'service_account', label: `Servis kullanıcısı: ${serviceEnv.ui_user}` }
        : { mode: 'none', label: 'Oturum YOK — ekran görüntüleri için yetkilendirme gerekecek' };

    const envContext = await buildEnvironmentContext(this.prisma, project.customer_id, project.id);
    const childBlock = children.length
      ? `\nALT GÖREVLER (${children.length}):\n${children.map((c) => `- #${c.id} [${c.state}] ${c.title}${c.descriptionFull ? `: ${c.descriptionFull.slice(0, 300)}` : ''}`).join('\n')}\n`
      : '';
    const targetLines = [
      fnoEnv ? `- D365 Finance & SCM: ${fnoEnv.name} (${fnoEnv.base_url ?? ''}) — şirket kodları: ${companies.join(', ') || '?'}` : null,
      bcEnv ? `- D365 Business Central: ${bcEnv.name} (environment: ${bcEnv.base_url ?? 'Production'}) — şirketler: ${bcCompanies.join(', ') || '?'}` : null,
      webEnv ? `- Web Uygulaması: ${webEnv.name} (${webEnv.base_url ?? ''})` : null,
    ].filter(Boolean) as string[];
    const body =
      `İŞ KALEMİ: #${story.id} — ${story.title} [${story.type}]\n` +
      `AÇIKLAMA: ${story.descriptionFull || '(boş)'}\n` +
      (story.acceptance ? `KABUL KRİTERLERİ: ${story.acceptance}\n` : '') +
      childBlock +
      (envContext ? `\n${envContext}\n` : '') +
      `\nHEDEF ORTAMLAR:\n${targetLines.join('\n') || 'bağlı ortam yok'}\n`;

    // Screen vocabulary: ONLY the platforms this project actually has an
    // environment for — the model cannot plan screens we cannot capture.
    const screenVocab = [
      fnoEnv && 'F&O ekranı: {"platform":"fno","mi":"CustTableListPage","cmp":"USMF","caption":"..."} — mi için YALNIZ standart menu item adları (DefaultDashboard, CustTableListPage, SalesTableListPage, VendTableListPage, EcoResProductListPage, LedgerJournalTable5, HcmWorker, ProjProjectsListPage); custom ad UYDURMA, emin değilsen DefaultDashboard. cmp DAİMA şirket KODU (örn. USMF).',
      bcEnv && 'BC ekranı: {"platform":"bc","page":21,"company":"CRONUS","caption":"..."} — page için YALNIZ standart sayfa ID: 22 Müşteri Listesi, 21 Müşteri Kartı, 27 Satıcı Listesi, 26 Satıcı Kartı, 31 Ürün Listesi, 30 Ürün Kartı, 9305 Satış Sipariş Listesi, 42 Satış Siparişi, 9300 Satış Teklif Listesi, 41 Satış Teklifi. company şirketin görünen ADI (HEDEF ORTAMLAR listesinden).',
      webEnv && 'Web ekranı: {"platform":"web","path":"/","caption":"..."} — path uygulama içi rota, / ile başlar.',
    ].filter(Boolean).join('\n');

    let data: any = null;
    for (const plannerModel of ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct']) {
      data = await runAgent({
      run_id: `doc-plan-${wid}-${plannerModel.includes('70b') ? 'l' : 's'}-${Date.now()}`,
      workspace_id: project.workspace_id ?? undefined,
      ai_resource: {
        key: 'ai_doc_planner',
        name: 'AI Doc Planner',
        system_prompt:
          'Sen kıdemli bir D365 danışmanısın. Verilen user story için müşteriye teslim edilecek eğitim dokümanının HAZIRLIK PLANINI çıkar. ' +
          (screenVocab
            ? `Ekran planlarken YALNIZ şu platform sözlüklerini kullan (projenin bağlı ortamları bunlar):\n${screenVocab}\n`
            : 'Bağlı ortam yok — ekranlar boş dizi olsun.\n') +
          'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun; content alanına SADECE plan JSON\'unu string olarak koy:\n' +
          '{"draft":{"kind":"note","subject":null,"content":"{\\"modul\\":\\"Accounts receivable\\",\\"sirket\\":\\"USMF\\",\\"yontem\\":[\\"madde1\\",\\"madde2\\"],\\"veriseti\\":[\\"örnek veri açıklaması\\"],\\"ekranlar\\":[{\\"platform\\":\\"fno\\",\\"mi\\":\\"CustTableListPage\\",\\"cmp\\":\\"USMF\\",\\"caption\\":\\"Müşteri listesi\\"}],\\"onkosullar\\":[\\"madde\\"]}","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
          'yontem: dokümanın nasıl ilerleyeceği (4-6 madde, Türkçe); veriseti: hangi örnek kayıt/verilerle anlatılacağı (2-4 madde); ekranlar: en fazla 6 ekran, her biri platform alanı taşır; onkosullar: doküman için gerekenler. JSON dışında hiçbir metin yazma.',
        provider: 'nvidia',
        model: plannerModel,
        temperature: 0.2,
        tools: [],
        confidence_threshold: 0.5,
      },
      activity: { id: `dp-${Date.now()}`, channel: 'manual', subject: `${story.title} — doküman planı`, body, priority: 'normal', customer: null },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
      });
      // Parse INSIDE the ladder — a parse failure also advances to the next
      // model. Models sometimes return content as an OBJECT instead of string.
      if (data) {
        const raw = data?.draft?.content;
        if (raw && typeof raw === 'object' && (raw as any).yontem) { data.__plan = raw; break; }
        const content = String(raw ?? '');
        try {
          const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
          if (parsed?.yontem) { data.__plan = parsed; break; }
        } catch { /* fallthrough */ }
      }
      this.logger.warn(`doc-plan: ${plannerModel} başarısız/ayrıştırılamadı — sıradaki model`);
      data = null;
    }
    const plan: any = data?.__plan ?? null;
    if (!plan?.yontem) return { ok: false, detail: 'plan üretilemedi — tekrar deneyin' };

    // Normalize company references to VALID codes (cmp= must be a code).
    const toCode = (v?: string | null): string | null => {
      if (!v) return null;
      let s = String(v).trim();
      // 'dat' is the empty F&O system company — never document against it
      // when a real company exists (screenshots would show blank data).
      if (s.toLowerCase() === 'dat' && companyCodes.some((c: string) => c.toLowerCase() !== 'dat')) s = '';
      if (s && companyCodes.some((c: string) => c.toLowerCase() === s.toLowerCase())) return companyCodes.find((c: string) => c.toLowerCase() === s.toLowerCase())!;
      const byName = companyRows.find((c: any) => String(c.name ?? '').toLowerCase() === s.toLowerCase());
      // Fallback: prefer a REAL company over the empty 'dat' system company.
      const preferred = companyCodes.find((c: string) => c.toLowerCase() !== 'dat') ?? companyCodes[0] ?? null;
      return byName ? String(byName.id ?? byName.name) : preferred;
    };
    plan.sirket = fnoEnv ? toCode(plan.sirket) : (plan.sirket ?? bcCompanies[0] ?? null);
    // Per-platform screen normalization: infer missing platform from the
    // fields present; F&O gets company CODES, BC gets display NAMES + numeric
    // page ids; unsupported platforms (no env) are dropped.
    const supported = new Set([fnoEnv && 'fno', bcEnv && 'bc', webEnv && 'web'].filter(Boolean));
    plan.ekranlar = (plan.ekranlar ?? []).filter((e: any) => {
      if (!e.platform) e.platform = e.page != null ? 'bc' : e.path ? 'web' : 'fno';
      if (!supported.has(e.platform)) return false;
      if (e.platform === 'fno') {
        e.cmp = toCode(e.cmp) ?? toCode(plan.sirket) ?? undefined;
      } else if (e.platform === 'bc') {
        const name = String(e.company ?? plan.sirket ?? '').trim();
        e.company = bcCompanies.find((c) => c.toLowerCase() === name.toLowerCase()) ?? bcCompanies[0] ?? (name || undefined);
        e.page = String(e.page ?? '').replace(/[^0-9]/g, '') || undefined;
        if (!e.page) return false;
      } else if (e.platform === 'web') {
        e.path = String(e.path ?? '/');
        if (!e.path.startsWith('/') || e.path.startsWith('//')) e.path = '/';
      }
      return true;
    });

    const stackLabels = [...stack].map((k) => PLATFORM_LABEL[k] ?? k);
    const fullPlan = {
      platform: stackLabels.join(' + ') || 'ortam bağlı değil',
      ortam: targetLines.length ? targetLines.map((l) => l.replace(/^- /, '')).join(' · ') : null,
      oturum: sessionInfo,
      modul: plan.modul ?? null,
      sirket: plan.sirket ?? companies[0] ?? bcCompanies[0] ?? null,
      yontem: plan.yontem ?? [],
      veriseti: plan.veriseti ?? [],
      ekranlar: (plan.ekranlar ?? []).slice(0, 6),
      onkosullar: plan.onkosullar ?? [],
      meta: defaultPlanMeta,
      assist_needed: sessionInfo.mode === 'none',
      assist_hint: sessionInfo.mode === 'none' ? `Ekran görüntüleri için: node scripts/env-login.mjs ${primary?.id ?? '<envId>'}` : null,
    };
    const planDoc = await this.prisma.documents.create({
      data: {
        workspace_id: project.workspace_id ?? undefined,
        title: `${story.title} — Doküman Planı`.slice(0, 400),
        source_type: 'agent_draft',
        mime_type: 'application/json',
        status: 'uploaded',
        customer_id: project.customer_id ?? undefined,
        project_id: project.id,
        metadata: { doc_kind: 'story_doc_plan', plan: fullPlan, ado: { org: project.devops_org, project: project.devops_project, id: story.id }, generatedAt: new Date().toISOString() },
      },
    });
    await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'documents', entityId: planDoc.id, summary: `Doc plan prepared for story #${story.id} (${children.length} alt görev)` });
    return {
      ok: true, ready: true, checks, planDocId: planDoc.id, plan: fullPlan,
      story: { id: story.id, title: story.title },
      children: children.map((c) => ({ id: c.id, title: c.title, state: c.state })),
    };
  }

  @Roles('consultant')
  @Patch('projects/:id/stories/:wid/doc-plan')
  async updateDocPlanMeta(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: {
      planDocId?: string;
      meta?: { hedef_kitle?: string; ornek_kayit?: string; surum?: string; tur?: string };
    },
  ) {
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    if (!body?.planDocId) return { ok: false, detail: 'planDocId gerekli' };
    const project = await (this.prisma as any).projects.findUnique({ where: { id } });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const planDoc = await this.prisma.documents.findFirst({
      where: { id: body.planDocId, workspace_id: wsId, project_id: id },
    });
    const metadata = ((planDoc?.metadata as any) ?? {}) as Record<string, any>;
    const currentPlan = metadata.plan as DocPlan | undefined;
    if (!planDoc || metadata.doc_kind !== 'story_doc_plan' || !currentPlan ||
        String(metadata.ado?.id ?? '') !== String(wid)) {
      return { ok: false, detail: 'bu iş kalemine ait doküman planı bulunamadı' };
    }

    const requestedMeta = body.meta ?? {};
    const metaPatch: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(requestedMeta, 'hedef_kitle')) {
      metaPatch.hedef_kitle = String(requestedMeta.hedef_kitle ?? '').trim().slice(0, 200);
    }
    if (Object.prototype.hasOwnProperty.call(requestedMeta, 'ornek_kayit')) {
      metaPatch.ornek_kayit = String(requestedMeta.ornek_kayit ?? '').trim().slice(0, 600);
    }
    if (Object.prototype.hasOwnProperty.call(requestedMeta, 'surum')) {
      metaPatch.surum = String(requestedMeta.surum ?? '').trim().slice(0, 40);
    }
    if (Object.prototype.hasOwnProperty.call(requestedMeta, 'tur')) {
      const kind = String(requestedMeta.tur ?? '').trim();
      if (!['egitim', 'surec', 'kullanim'].includes(kind)) {
        return { ok: false, detail: 'tur egitim, surec veya kullanim olmalı' };
      }
      metaPatch.tur = kind;
    }
    const nextPlan: DocPlan = {
      ...currentPlan,
      meta: { ...((currentPlan.meta as any) ?? {}), ...metaPatch },
    };

    if (!project.devops_org || !project.devops_project) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story || String(story.id) !== String(wid)) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };
    const children = await fetchChildItems(project.devops_org, story).catch(() => []);
    const contentLen =
      (story.descriptionFull?.length ?? 0) + (story.acceptance?.length ?? 0) +
      children.reduce((total, child) => total + (child.descriptionFull?.length ?? 0) + child.title.length, 0);
    const adoEditUrl = `https://dev.azure.com/${project.devops_org}/${encodeURIComponent(String(project.devops_project))}/_workitems/edit/${story.id}`;
    const allEnvs = await (this.prisma as any).customer_environments.findMany({
      where: { customer_id: project.customer_id },
      select: { id: true, kind: true, name: true, status: true, ui_user: true, ui_session_encrypted: true },
    });
    const connected = allEnvs.filter((env: any) => env.status === 'connected');
    const stack = new Set<string>();
    for (const repo of ((project.repos as any[]) ?? [])) {
      stack.add(repo.kind === 'bc-al' ? 'bc' : repo.kind === 'fno-xpp' ? 'fno' : 'web');
    }
    for (const env of connected) stack.add(env.kind);
    const connectedKinds = new Set<string>(connected.map((env: any) => String(env.kind)));
    const missingPlatforms = [...stack].filter((kind) => !connectedKinds.has(kind));
    const hasEnv = connected.length > 0;
    const hasSession = connected.some((env: any) => env.ui_session_encrypted || env.ui_user);
    const checks: any[] = [
      {
        key: 'icerik', ok: contentLen >= 150, blocker: true,
        message: contentLen >= 150
          ? `İçerik yeterli (${contentLen} kr — story + ${children.length} alt görev)`
          : `İçerik YETERSİZ (${contentLen} kr): story açıklaması/kabul kriterleri ve alt görev açıklamaları neredeyse boş — anlamlı doküman üretilemez.`,
        fix: contentLen >= 150 ? null : { label: `ADO'da #${story.id} açıklamasını ve kabul kriterlerini doldurun`, url: adoEditUrl },
      },
      {
        key: 'ortam', ok: hasEnv && !missingPlatforms.length, blocker: false,
        message: !hasEnv
          ? 'Bağlı müşteri ortamı YOK — doküman genel kalır, ekran görüntüsü çekilemez.'
          : missingPlatforms.length
            ? `Bazı platformların ortamı bağlı değil: ${missingPlatforms.map((kind) => PLATFORM_LABEL[kind] ?? kind).join(', ')} — bu platformların ekranları çekilemez.`
            : `Müşteri ortamı bağlı (${[...connectedKinds].map((kind) => PLATFORM_LABEL[kind] ?? kind).join(', ')}) — doküman gerçek ortam bilgisiyle yazılır`,
        fix: hasEnv && !missingPlatforms.length ? null : { label: 'Müşteri Ortamları sayfasından eksik platform ortamını ekleyin', url: '/settings/environments' },
      },
      {
        key: 'oturum', ok: hasSession, blocker: false,
        message: hasSession ? 'Ekran görüntüsü oturumu hazır' : 'Oturum YOK — doküman ekran görüntüsüz üretilir.',
        fix: hasSession ? null : { label: `Oturum bağışlayın: node scripts/env-login.mjs ${connected[0]?.id ?? '<envId>'}`, url: '/settings/environments' },
      },
      ...await this.docMetaReadinessChecks((nextPlan.meta as any) ?? {}),
    ];
    const updatedAt = new Date().toISOString();
    await this.prisma.documents.update({
      where: { id: planDoc.id },
      data: {
        metadata: {
          ...metadata,
          plan: nextPlan,
          doc_kind: 'story_doc_plan',
          planUpdatedAt: updatedAt,
        } as any,
      },
    });
    await this.audit.log({
      actorType: 'user', action: 'update', entityType: 'documents', entityId: planDoc.id,
      summary: `Story #${story.id} doküman planı meta alanları güncellendi`,
    });
    return {
      ok: true,
      ready: !checks.some((check) => check.blocker && !check.ok),
      checks,
      planDocId: planDoc.id,
      plan: nextPlan,
    };
  }

  private async persistDocBuildRun(projectId: string, run: DocBuildRun): Promise<void> {
    try {
      const fresh = await (this.prisma as any).projects.findUnique({ where: { id: projectId }, select: { metadata: true } });
      const metadata = ((fresh?.metadata as any) ?? {}) as Record<string, unknown>;
      const current = metadata.doc_build_run as DocBuildRun | undefined;
      // A stale detached task must not overwrite a newer run started after it.
      if (current?.runId && current.runId !== run.runId) return;
      await (this.prisma as any).projects.update({
        where: { id: projectId },
        data: { metadata: { ...metadata, doc_build_run: run } },
      });
    } catch (error) {
      this.logger.warn(`doc-build ${run.runId}: ilerleme kaydedilemedi — ${(error as Error).message}`);
    }
  }

  private async buildDocCodeContext(project: any, story: any): Promise<string> {
    try {
      const profiles = (((project.metadata as any)?.repo_profile?.repos ?? []) as RepoProfile[]);
      if (!profiles.length) return '';
      const keywords = extractKeywords(`${story.title} ${story.descriptionFull ?? ''}`);
      const files = findRelevantFiles(profiles, keywords, 3);
      const parts: string[] = [];
      let budget = 6000;
      for (const file of files) {
        const raw = await getFileContent(file.repo, file.path, 40_000);
        if (!raw) continue;
        const excerpt = raw.split('\n').slice(0, 400).join('\n').slice(0, Math.min(2500, budget));
        if (!excerpt.trim()) continue;
        budget -= excerpt.length;
        parts.push(`--- ${file.repo}/${file.path} ---\n${excerpt}`);
        if (budget <= 0) break;
      }
      return parts.length ? `=== İLGİLİ KOD (repo — gerçek uygulama detayı) ===\n${parts.join('\n\n')}\n\n` : '';
    } catch {
      return '';
    }
  }

  private async writeDocSection(opts: {
    project: any;
    story: any;
    definition: DocSectionDefinition;
    prompt: string;
    context: string;
  }): Promise<{ markdown: string; model: string } | null> {
    const hasRequiredFormat = (markdown: string): boolean => {
      const compact = markdown.replace(/[ \t]*\|[ \t]*/g, '|').toLocaleLowerCase('tr-TR');
      if (opts.definition.key === 'purpose') return compact.includes('|konu|beklenen durum|');
      if (opts.definition.key === 'concepts') return compact.includes('|terim|anlamı|');
      if (opts.definition.key === 'flow') {
        return compact.includes('|adım|ekran|yapılan işlem|çıktı|') && /```mermaid\s*[\r\n]+\s*flowchart\s+TD\b/i.test(markdown);
      }
      if (opts.definition.key === 'situations') {
        return compact.includes('|durum|olası neden|yapılacak|') && compact.includes('|türkçe|ingilizce|');
      }
      if (opts.definition.screenIndex) {
        return compact.includes('|alan|örnek değer|açıklama|') &&
          /\*\*Ekranda ne yapılır\*\*/i.test(markdown) &&
          /\*\*Ekranda ne görülür\*\*/i.test(markdown) &&
          markdown.includes(`[[SCREENSHOT:${opts.definition.screenIndex}]]`);
      }
      return true;
    };
    const models = (process.env.DOC_MODELS ?? 'meta/llama-3.3-70b-instruct,meta/llama-3.1-8b-instruct')
      .split(',').map((model) => model.trim()).filter(Boolean);
    for (const model of models) {
      const data = await runAgent({
        run_id: `story-doc-${opts.story.id}-${opts.definition.key}-${Date.now()}`,
        workspace_id: opts.project.workspace_id ?? undefined,
        ai_resource: {
          key: 'ai_doc_writer',
          name: 'AI Doc Writer',
          system_prompt:
            'Sen Dynamics 365 (BC/F&O) alanında kıdemli bir danışmansın ve müşteriye teslim edilecek eğitim/süreç dokümanı yazıyorsun.\n' +
            `${opts.prompt}\n` +
            'Yanıtın TAMAMI AgentResult JSON nesnesi olsun. İstenen başlıklı Markdown metninin tamamını draft.content alanına koy; JSON dışında metin yazma. ' +
            'Diğer alanlar: draft.kind="note", recipients=[], citations=[], reasoning_summary kısa, confidence 0-1, needs_escalation=false, escalate_to=null, tool_intents=[].',
          provider: 'nvidia',
          model,
          temperature: 0.35,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: {
          id: `sd-${opts.definition.key}-${Date.now()}`,
          channel: 'manual',
          subject: `${opts.story.title} — ${opts.definition.label}`,
          body: opts.context,
          priority: 'normal',
          customer: null,
        },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      });
      let markdown = String(data?.draft?.content ?? '').trim();
      const outerFence = markdown.match(/^```(?:markdown|md)\s*\n([\s\S]*)\n```\s*$/i);
      if (outerFence) markdown = outerFence[1].trim();
      const headingsPresent = opts.definition.requiredHeadings.every((heading) => markdown.includes(heading));
      if (markdown.length >= 40 && headingsPresent && hasRequiredFormat(markdown)) return { markdown, model };
      this.logger.warn(`doc-build #${opts.story.id} ${opts.definition.key}: ${model} başarısız/biçimsiz — sıradaki model`);
    }
    return null;
  }

  private async observeScreenshotFields(opts: {
    project: any;
    story: any;
    screenIndex: number;
    caption: string;
    dataUri?: string;
  }): Promise<ObservedField[]> {
    if (!process.env.NVIDIA_API_KEY?.trim() || !opts.dataUri) return [];
    const encoded = opts.dataUri.match(/^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i)?.[1];
    if (!encoded) return [];
    const data = await runAgent({
      run_id: `story-doc-vision-${opts.story.id}-${opts.screenIndex}-${Date.now()}`,
      workspace_id: opts.project.workspace_id ?? undefined,
      ai_resource: {
        key: 'ai_doc_vision',
        name: 'AI Doc Vision',
        system_prompt:
          'Sen D365 ekranlarını inceleyen kıdemli bir danışmansın. Görselde açıkça okunabilen ve eğitim adımı için anlamlı alan/değer çiftlerini çıkar. ' +
          'Parola, erişim belirteci veya gizli değerleri alma. Okunmayan değeri uydurma. draft.content içinde yalnız `| Alan | Değer |` başlıklı Markdown tablosu yaz. ' +
          'Yanıtın TAMAMI AgentResult JSON nesnesi olsun; draft.kind="note", recipients=[], citations=[], tool_intents=[].',
        provider: 'nvidia',
        model: process.env.NVIDIA_VISION_MODEL?.trim() || 'meta/llama-3.2-11b-vision-instruct',
        temperature: 0.1,
        tools: [],
        confidence_threshold: 0.5,
      },
      activity: {
        id: `sdv-${opts.screenIndex}-${Date.now()}`,
        channel: 'manual',
        subject: `${opts.caption} — ekran alanları`,
        body: `#${opts.story.id} ${opts.story.title}; ekran ${opts.screenIndex}: ${opts.caption}`,
        priority: 'normal',
        customer: null,
      },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
      images: [encoded],
    });
    const usage = data?.token_usage ?? {};
    if (usage.provider !== 'nvidia' || usage.fallback_from || usage.fallback || usage.stub) return [];
    return parseObservedFields(data?.draft?.content);
  }

  private async queueDocDeliveryApproval(opts: {
    workspaceId: string;
    project: any;
    story: any;
    doc: any;
    requestedById?: string | null;
  }): Promise<string> {
    const resource =
      (await this.prisma.ai_resources.findFirst({ where: { key: 'ai_delivery_pm', status: 'active' } })) ??
      (await this.prisma.ai_resources.findFirst({ where: { status: 'active' } }));
    if (!resource) throw new Error('aktif AI kaynağı bulunamadı');

    const integrations = await this.prisma.integrations.findMany({
      where: { type: 'ado_org' as any },
      select: { id: true, config: true, is_mock: true },
    });
    const targetOrg = String(opts.project.devops_org ?? '').toLocaleLowerCase('en-US');
    const matchingTargets = integrations.filter((integration) =>
      String((integration.config as any)?.org ?? '').toLocaleLowerCase('en-US') === targetOrg);
    const target = matchingTargets.find((integration) => !integration.is_mock) ?? matchingTargets[0];
    const comment = `📘 Müşteri eğitim dokümanı hazırlandı: "${opts.doc.title}" (DynOps doc ${opts.doc.id}). Platform üzerinden görüntülenebilir/PDF alınabilir.`;

    const args = {
      workItemId: opts.story.id,
      project: opts.project.devops_project,
      text: comment,
      documentId: opts.doc.id,
    };
    return (this.prisma as any).$transaction(async (tx: any) => {
      const activity = await tx.activities.create({
        data: {
          workspace_id: opts.workspaceId,
          channel: 'manual',
          subject: `ADO #${opts.story.id} — eğitim dokümanı bildirimi`.slice(0, 500),
          body: comment,
          status: 'awaiting_approval',
          customer_id: opts.project.customer_id ?? undefined,
          project_id: opts.project.id,
          requires_approval: true,
          metadata: { source: 'story_doc', document_id: opts.doc.id, work_item_id: String(opts.story.id) },
        },
      });
      const agentRun = await tx.agent_runs.create({
        data: {
          workspace_id: opts.workspaceId,
          activity_id: activity.id,
          ai_resource_id: resource.id,
          customer_id: opts.project.customer_id ?? undefined,
          project_id: opts.project.id,
          llm_provider: resource.llm_provider,
          llm_model: resource.llm_model,
          status: 'needs_approval',
          input: { source: 'story_doc', document_id: opts.doc.id },
          output: {},
          tools_used: ['devops_comment'],
        },
      });
      const toolCall = await tx.tool_calls.create({
        data: {
          workspace_id: opts.workspaceId,
          agent_run_id: agentRun.id,
          name: 'devops_comment',
          args,
          requires_approval: true,
          risk_level: 'high',
          status: 'awaiting_approval',
          sequence: 0,
          target_integration_id: target?.id ?? undefined,
        },
      });
      const approval = await tx.approvals.create({
        data: {
          workspace_id: opts.workspaceId,
          activity_id: activity.id,
          agent_run_id: agentRun.id,
          tool_call_id: toolCall.id,
          action: 'devops_comment',
          payload: args,
          risk_level: 'high',
          reason: `ADO #${opts.story.id} eğitim dokümanı hazır bildirimi`.slice(0, 200),
          status: 'pending',
          requested_by_id: isUuid(opts.requestedById) ? opts.requestedById : undefined,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      return approval.id as string;
    });
  }

  private async executeDocBuild(opts: {
    project: any;
    story: any;
    planDocId: string;
    plan: DocPlan;
    definitions: DocSectionDefinition[];
    deliver: boolean;
    requestedById?: string | null;
    workspaceId: string;
    run: DocBuildRun;
  }): Promise<void> {
    const { project, story, plan, run } = opts;
    try {
      const [comments, docChildren, envContext, codeBlock] = await Promise.all([
        fetchWorkItemComments(project.devops_org, String(story.id), 15, { filterSelf: true }).catch(() => []),
        fetchChildItems(project.devops_org, story).catch(() => []),
        buildEnvironmentContext(this.prisma, project.customer_id, project.id).catch(() => ''),
        this.buildDocCodeContext(project, story),
      ]);
      const planBlock =
        `=== ONAYLANMIŞ PLAN (dokümanı BU plana göre yaz) ===\n` +
        `Platform: ${plan.platform ?? '-'} · Ortam: ${plan.ortam ?? '-'} · Şirket: ${plan.sirket ?? '-'} · Modül: ${plan.modul ?? '-'}\n` +
        `Yöntem:\n${(plan.yontem ?? []).map((item) => `- ${String(item)}`).join('\n')}\n` +
        `Veri seti:\n${(plan.veriseti ?? []).map((item) => `- ${String(item)}`).join('\n')}\n\n`;
      const context =
        `MÜŞTERİ: ${project.customer?.name ?? project.name}\nPROJE: ${project.name} (ADO: ${project.devops_org}/${project.devops_project})\n` +
        `İŞ KALEMİ: #${story.id} — ${story.title} [${story.type}/${story.state}]${story.assignee ? ` — sorumlu: ${story.assignee}` : ''}\n\n` +
        planBlock +
        (envContext ? `${envContext}\n\n` : '') +
        codeBlock +
        `=== AÇIKLAMA ===\n${story.descriptionFull || '(boş)'}\n\n` +
        (story.acceptance ? `=== KABUL KRİTERLERİ ===\n${story.acceptance}\n\n` : '') +
        (docChildren.length
          ? `=== ALT GÖREVLER (${docChildren.length}) ===\n${docChildren.map((child) => `- #${child.id} [${child.state}] ${child.title}${child.descriptionFull ? `: ${child.descriptionFull.slice(0, 500)}` : ''}`).join('\n')}\n\n`
          : '') +
        (comments.length ? `=== YORUMLAR ===\n${comments.map((comment) => `${comment.by ?? '?'}: ${comment.text.slice(0, 400)}`).join('\n')}\n` : '');

      const generated: GeneratedDocSection[] = [];
      const screenshots: DocScreenshot[] = [];
      let diagram: Awaited<ReturnType<typeof prepareFlowSection>>['diagram'] = null;
      const templateKind = resolveDocTemplateKind(plan.meta?.tur);
      const pacingMs = Math.min(2000, Math.max(1000, Number(process.env.DOC_SECTION_PACING_MS ?? 1500) || 1500));

      for (let position = 0; position < opts.definitions.length; position++) {
        const definition = opts.definitions[position];
        const startedAt = new Date().toISOString();
        let markdown = '';
        let model: string | null = null;
        let status: 'done' | 'warn' = 'done';
        try {
          if (!definition.modelRequired) {
            markdown = buildCoverSection({ title: story.title, plan, tur: templateKind });
          } else {
            let observedFields: ObservedField[] | undefined;
            let prompt: string | null;
            if (definition.key === 'flow') {
              const prepared = await prepareFlowSection({
                title: story.title,
                plan,
                tur: templateKind,
                processSummary: (plan.yontem ?? []).map(String).join(' → '),
              });
              diagram = prepared.diagram;
              prompt = prepared.prompt;
            } else {
              if (definition.screenIndex) {
                const screen = plan.ekranlar?.[definition.screenIndex - 1] ?? {};
                const caption = String(screen.caption ?? screen.title ?? `Ekran ${definition.screenIndex}`).trim();
                const spec = { ...screen, caption } as ShotSpec;
                const shot = await captureEnvironmentShots(this.prisma, project.customer_id, [spec], project.id)
                  .then((items) => items[0] ?? null)
                  .catch(() => null);
                screenshots.push({
                  screenIndex: definition.screenIndex,
                  caption,
                  ...(shot?.dataUri ? { dataUri: shot.dataUri } : { placeholder: `📷 [Ekran görüntüsü: ${caption}]` }),
                });
                observedFields = await this.observeScreenshotFields({
                  project,
                  story,
                  screenIndex: definition.screenIndex,
                  caption,
                  dataUri: shot?.dataUri,
                }).catch(() => []);
              }
              prompt = buildSectionPrompt(definition, {
                title: story.title,
                plan,
                tur: templateKind,
                hasSolutionStack: Boolean(envContext && envContext.includes('ÇÖZÜM YIĞINI')),
                processSummary: (plan.yontem ?? []).map(String).join(' → '),
              }, observedFields);
            }
            const result = prompt ? await this.writeDocSection({ project, story, definition, prompt, context }) : null;
            if (result) {
              markdown = result.markdown;
              model = result.model;
            } else {
              status = 'warn';
              markdown = buildSectionWarningStub(definition);
            }
          }
        } catch (error) {
          status = 'warn';
          markdown = buildSectionWarningStub(definition);
          this.logger.warn(`doc-build ${run.runId} ${definition.key}: ${(error as Error).message}`);
        }

        generated.push({
          key: definition.key,
          index: definition.index,
          screenIndex: definition.screenIndex,
          markdown,
          status,
          model,
        });
        run.section = definition.index;
        run.sectionName = definition.label;
        run.sections.push({
          key: definition.key,
          index: definition.index,
          label: definition.label,
          status,
          model,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        await this.persistDocBuildRun(project.id, run);
        if (position < opts.definitions.length - 1) await wait(pacingMs);
      }

      const assembled = await assembleDocSections({ sections: generated, plan, diagram, screenshots });
      const capturedShots = screenshots.filter((shot) => Boolean(shot.dataUri)).length;
      const models = [...new Set(generated.map((section) => section.model).filter((model): model is string => Boolean(model)))];
      const generatedAt = new Date().toISOString();
      const documentMetadata: Record<string, unknown> = {
        content: assembled.markdown,
        doc_kind: 'story_training_doc',
        ado: { org: project.devops_org, project: project.devops_project, id: story.id, title: story.title },
        model: models[0] ?? null,
        screenshots: capturedShots,
        generatedAt,
        meta: plan.meta ?? {},
        drawio_xml: assembled.drawioXml,
        drawio_source: assembled.drawioSource,
        diagram_rendered: assembled.diagramRendered,
        sections: generated,
      };
      const doc = await this.prisma.documents.create({
        data: {
          workspace_id: project.workspace_id ?? undefined,
          title: `${story.title} — Eğitim Dokümanı`.slice(0, 400),
          source_type: 'agent_draft',
          mime_type: 'text/markdown',
          status: 'uploaded',
          customer_id: project.customer_id ?? undefined,
          project_id: project.id,
          metadata: documentMetadata as any,
        },
      });

      const currentPlanDoc = await this.prisma.documents.findFirst({
        where: { id: opts.planDocId, workspace_id: opts.workspaceId, project_id: project.id },
        select: { metadata: true },
      }).catch(() => null);
      if (currentPlanDoc) {
        await this.prisma.documents.update({
          where: { id: opts.planDocId },
          data: {
            status: 'processed' as any,
            metadata: {
              ...(((currentPlanDoc.metadata as any) ?? {}) as Record<string, unknown>),
              plan,
              doc_kind: 'story_doc_plan',
              executedAt: generatedAt,
              outputDocId: doc.id,
            } as any,
          },
        }).catch(() => {});
      }

      let approvalId: string | null = null;
      let deliveryError: string | null = null;
      if (opts.deliver) {
        try {
          approvalId = await this.queueDocDeliveryApproval({
            workspaceId: opts.workspaceId,
            project,
            story,
            doc,
            requestedById: opts.requestedById,
          });
        } catch (error) {
          deliveryError = (error as Error).message.slice(0, 300);
          this.logger.warn(`doc-build ${run.runId}: ADO bildirim onayı kurulamadı — ${deliveryError}`);
        }
        await this.prisma.documents.update({
          where: { id: doc.id },
          data: {
            metadata: {
              ...documentMetadata,
              delivery: approvalId
                ? { requested: true, status: 'pending_approval', approvalId }
                : { requested: true, status: 'error', error: deliveryError },
            },
          },
        }).catch(() => {});
      }

      run.phase = 'done';
      run.finishedAt = new Date().toISOString();
      run.docId = doc.id;
      run.error = null;
      run.delivered = false;
      run.deliveryApprovalId = approvalId;
      run.deliveryStatus = opts.deliver ? (approvalId ? 'pending_approval' : 'error') : 'not_requested';
      run.deliveryError = deliveryError;
      run.screenshots = capturedShots;
      run.htmlPath = `/story-docs/${doc.id}/html`;
      run.pdfPath = `/story-docs/${doc.id}/pdf`;
      await this.persistDocBuildRun(project.id, run);
      await this.audit.log({
        actorType: 'system',
        action: 'execute',
        entityType: 'documents',
        entityId: doc.id,
        summary: `Story #${story.id} eğitim dokümanı üretildi${approvalId ? ' + ADO bildirimi onaya gönderildi' : ''}`,
      }).catch(() => {});
    } catch (error) {
      run.phase = 'failed';
      run.finishedAt = new Date().toISOString();
      run.error = (error as Error).message.slice(0, 500);
      await this.persistDocBuildRun(project.id, run);
      this.logger.error(`doc-build ${run.runId} başarısız: ${run.error}`);
    }
  }

  // ── Detached customer-deliverable document build ──────────────────────────
  @Roles('consultant')
  @Post('projects/:id/stories/:wid/doc')
  async generateDoc(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: { deliver?: boolean; planDocId?: string },
    @CurrentUser() user?: AuthUser,
  ) {
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    if (!body?.planDocId) return { ok: false, detail: 'onaylı doküman planı gerekli' };
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    if (!project.devops_org || !project.devops_project) return { ok: false, detail: 'proje ADO eşlemesi yok' };

    const planDoc = await this.prisma.documents.findFirst({
      where: { id: body.planDocId, workspace_id: wsId, project_id: id },
    });
    const planMetadata = (planDoc?.metadata as any) ?? {};
    const rawPlan = planMetadata.plan as DocPlan | undefined;
    if (!planDoc || planMetadata.doc_kind !== 'story_doc_plan' || !rawPlan) {
      return { ok: false, detail: 'onaylı doküman planı bulunamadı' };
    }
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story || String(story.id) !== String(wid)) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };
    const planAdo = planMetadata.ado ?? {};
    if (String(planAdo.id ?? '') !== String(story.id) ||
        String(planAdo.org ?? '') !== String(project.devops_org) ||
        String(planAdo.project ?? '') !== String(project.devops_project)) {
      return { ok: false, detail: 'doküman planı bu iş kalemine ait değil' };
    }

    const latestProject = await (this.prisma as any).projects.findUnique({ where: { id }, select: { metadata: true } });
    const projectMetadata = ((latestProject?.metadata as any) ?? {}) as Record<string, unknown>;
    const activeRun = projectMetadata.doc_build_run as DocBuildRun | undefined;
    if (activeRun?.phase === 'running' && !activeRun.finishedAt) {
      return { ok: false, detail: `doküman koşusu zaten çalışıyor (${activeRun.section}/${activeRun.totalSections})`, run: activeRun };
    }
    const asTextList = (value: unknown): string[] => Array.isArray(value)
      ? value.map((item) => String(item ?? '').trim()).filter(Boolean).slice(0, 20)
      : [];
    const rawMeta = rawPlan.meta && typeof rawPlan.meta === 'object' && !Array.isArray(rawPlan.meta)
      ? rawPlan.meta
      : {};
    const plan: DocPlan = {
      ...rawPlan,
      meta: { ...rawMeta, tur: resolveDocTemplateKind(rawMeta.tur) },
      yontem: asTextList(rawPlan.yontem),
      veriseti: asTextList(rawPlan.veriseti),
      onkosullar: asTextList(rawPlan.onkosullar),
      ekranlar: (Array.isArray(rawPlan.ekranlar) ? rawPlan.ekranlar : [])
        .filter((screen) => Boolean(screen) && typeof screen === 'object' && !Array.isArray(screen))
        .slice(0, 6),
    };
    const definitions = createDocSectionDefinitions({ title: story.title, plan, tur: plan.meta?.tur });
    const run: DocBuildRun = {
      runId: randomUUID(),
      storyId: String(story.id),
      planDocId: planDoc.id,
      phase: 'running',
      section: 0,
      sectionName: null,
      totalSections: definitions.length,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      docId: null,
      error: null,
      sections: [],
    };
    await (this.prisma as any).projects.update({
      where: { id },
      data: { metadata: { ...projectMetadata, doc_build_run: run } },
    });

    void tenantStore.run({ workspaceId: wsId }, async () => {
      await this.executeDocBuild({
        project,
        story,
        planDocId: planDoc.id,
        plan,
        definitions,
        deliver: body.deliver !== false,
        requestedById: user?.id ?? null,
        workspaceId: wsId,
        run,
      });
    });
    return { ok: true, started: true, runId: run.runId };
  }

  @Roles('consultant')
  @Get('projects/:id/stories/:wid/doc-run')
  async docRun(@Param('id') id: string, @Param('wid') wid: string) {
    // Tenant guard (IDOR): the build run in metadata carries the docId + section
    // names, so scope to the caller's workspace like every sibling endpoint.
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    const project = await (this.prisma as any).projects.findUnique({ where: { id }, select: { workspace_id: true, metadata: true } });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const run = (((project.metadata as any) ?? {}).doc_build_run ?? null) as DocBuildRun | null;
    if (!run || String(run.storyId) !== String(wid)) return { ok: true, run: null };
    return { ok: true, run, ...(run.phase === 'done' && run.docId ? { docId: run.docId } : {}) };
  }

  @Roles('consultant')
  @Post('projects/:id/stories/:wid/doc/section')
  async regenerateDocSection(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: { docId?: string; sectionKey?: string },
  ) {
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    if (!body?.docId || !body?.sectionKey) return { ok: false, detail: 'docId ve sectionKey gerekli' };
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const doc = await this.prisma.documents.findFirst({
      where: { id: body.docId, workspace_id: wsId, project_id: id },
    });
    const documentMetadata = ((doc?.metadata as any) ?? {}) as Record<string, any>;
    if (!doc || documentMetadata.doc_kind !== 'story_training_doc' ||
        String(documentMetadata.ado?.id ?? '') !== String(wid) || !documentMetadata.content) {
      return { ok: false, detail: 'bu iş kalemine ait eğitim dokümanı bulunamadı' };
    }
    if (!project.devops_org || !project.devops_project) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story || String(story.id) !== String(wid)) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };

    const planDocs = await this.prisma.documents.findMany({
      where: { workspace_id: wsId, project_id: id },
      orderBy: { created_at: 'desc' },
      select: { metadata: true },
      take: 50,
    });
    const planMetadataRows = planDocs
      .map((candidate) => ((candidate.metadata as any) ?? {}) as Record<string, any>)
      .filter((candidate) => candidate.doc_kind === 'story_doc_plan');
    const matchingPlanMetadata =
      planMetadataRows.find((candidate) => String(candidate.outputDocId ?? '') === String(doc.id)) ??
      planMetadataRows.find((candidate) => String(candidate.ado?.id ?? '') === String(wid));
    const rawPlan = matchingPlanMetadata?.plan as DocPlan | undefined;
    if (!rawPlan) return { ok: false, detail: 'dokümanın onaylı planı bulunamadı' };
    const plan: DocPlan = {
      ...rawPlan,
      meta: { ...((rawPlan.meta as any) ?? {}), tur: resolveDocTemplateKind(rawPlan.meta?.tur) },
      ekranlar: (Array.isArray(rawPlan.ekranlar) ? rawPlan.ekranlar : []).slice(0, 6),
    };
    const definitions = createDocSectionDefinitions({ title: story.title, plan, tur: plan.meta?.tur });
    const persistedSections = Array.isArray(documentMetadata.sections) ? documentMetadata.sections : [];
    if (!persistedSections.some((section: any) => section?.key === body.sectionKey)) {
      return { ok: false, detail: 'bölüm dokümanın kayıtlı bölüm indeksinde bulunamadı' };
    }
    const definitionIndex = definitions.findIndex((candidate) => candidate.key === body.sectionKey);
    if (definitionIndex < 0) return { ok: false, detail: 'geçersiz veya bu planda bulunmayan bölüm anahtarı' };
    const definition = definitions[definitionIndex];
    const currentContent = String(documentMetadata.content);
    const start = headingOffset(currentContent, definition.requiredHeadings[0] ?? '');
    const nextDefinition = definitions[definitionIndex + 1];
    const end = nextDefinition?.requiredHeadings[0]
      ? headingOffset(currentContent, nextDefinition.requiredHeadings[0], Math.max(0, start) + 1)
      : currentContent.length;
    if (start < 0 || end < 0) return { ok: false, detail: 'dokümanda bölüm sınırı bulunamadı; içerik korunuyor' };
    const oldSection = currentContent.slice(start, end);

    const [comments, children, envContext, codeBlock] = await Promise.all([
      fetchWorkItemComments(project.devops_org, String(story.id), 15, { filterSelf: true }).catch(() => []),
      fetchChildItems(project.devops_org, story).catch(() => []),
      buildEnvironmentContext(this.prisma, project.customer_id, project.id).catch(() => ''),
      this.buildDocCodeContext(project, story),
    ]);
    const context =
      `MÜŞTERİ: ${project.customer?.name ?? project.name}\nPROJE: ${project.name} (ADO: ${project.devops_org}/${project.devops_project})\n` +
      `İŞ KALEMİ: #${story.id} — ${story.title} [${story.type}/${story.state}]\n\n` +
      `=== ONAYLANMIŞ PLAN ===\n${JSON.stringify(plan, null, 2)}\n\n` +
      (envContext ? `${envContext}\n\n` : '') + codeBlock +
      `=== AÇIKLAMA ===\n${story.descriptionFull || '(boş)'}\n\n` +
      (story.acceptance ? `=== KABUL KRİTERLERİ ===\n${story.acceptance}\n\n` : '') +
      (children.length ? `=== ALT GÖREVLER ===\n${children.map((child) => `- #${child.id} ${child.title}: ${child.descriptionFull ?? ''}`).join('\n')}\n\n` : '') +
      (comments.length ? `=== YORUMLAR ===\n${comments.map((comment) => `${comment.by ?? '?'}: ${comment.text.slice(0, 400)}`).join('\n')}\n` : '');

    let rawMarkdown = '';
    let model: string | null = null;
    let diagram: Awaited<ReturnType<typeof prepareFlowSection>>['diagram'] = null;
    const screenshots: DocScreenshot[] = [];
    if (!definition.modelRequired) {
      rawMarkdown = buildCoverSection({ title: story.title, plan, tur: plan.meta?.tur });
    } else {
      let prompt: string | null = null;
      let observedFields: ObservedField[] | undefined;
      if (definition.key === 'flow') {
        const prepared = await prepareFlowSection({
          title: story.title,
          plan,
          tur: plan.meta?.tur,
          processSummary: (plan.yontem ?? []).map(String).join(' → '),
        });
        diagram = prepared.diagram;
        prompt = prepared.prompt;
      } else {
        if (definition.screenIndex) {
          const screen = plan.ekranlar?.[definition.screenIndex - 1] ?? {};
          const caption = String(screen.caption ?? screen.title ?? `Ekran ${definition.screenIndex}`).trim();
          const shot = await captureEnvironmentShots(
            this.prisma, project.customer_id, [{ ...screen, caption } as ShotSpec], project.id,
          ).then((items) => items[0] ?? null).catch(() => null);
          const priorImage = oldSection.match(/!\[[^\]]*\]\((data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+)\)/i)?.[1];
          screenshots.push({
            screenIndex: definition.screenIndex,
            caption,
            ...(shot?.dataUri
              ? { dataUri: shot.dataUri }
              : priorImage
                ? { dataUri: priorImage }
                : { placeholder: `📷 [Ekran görüntüsü: ${caption}]` }),
          });
          observedFields = await this.observeScreenshotFields({
            project,
            story,
            screenIndex: definition.screenIndex,
            caption,
            dataUri: shot?.dataUri,
          }).catch(() => []);
        }
        prompt = buildSectionPrompt(definition, {
          title: story.title,
          plan,
          tur: plan.meta?.tur,
          hasSolutionStack: Boolean(envContext && envContext.includes('ÇÖZÜM YIĞINI')),
          processSummary: (plan.yontem ?? []).map(String).join(' → '),
        }, observedFields);
      }
      const generated = prompt
        ? await this.writeDocSection({ project, story, definition, prompt, context })
        : null;
      if (!generated) return { ok: false, detail: 'bölüm modellerin hiçbiriyle üretilemedi; mevcut içerik korundu' };
      rawMarkdown = generated.markdown;
      model = generated.model;
    }

    const existingDiagramSource = ['sidecar', 'nim', 'mock'].includes(String(documentMetadata.drawio_source))
      ? documentMetadata.drawio_source as 'sidecar' | 'nim' | 'mock'
      : 'mock';
    const assemblyDiagram = diagram ?? (typeof documentMetadata.drawio_xml === 'string' && documentMetadata.drawio_xml
      ? { xml: documentMetadata.drawio_xml, source: existingDiagramSource }
      : null);
    const assembled = await assembleDocSections({
      sections: [{
        key: definition.key,
        index: definition.index,
        screenIndex: definition.screenIndex,
        markdown: rawMarkdown,
        status: 'done',
        model,
      }],
      plan,
      diagram: definition.key === 'flow' ? assemblyDiagram : null,
      screenshots,
    });
    let replacement = assembled.markdown;
    if (definition.key === 'flow' && !/\(data:image\//i.test(replacement)) {
      const priorDiagram = oldSection.match(/!\[([^\]]*)\]\((data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+)\)/i);
      if (priorDiagram) {
        replacement = `${replacement.replace(/```mermaid\s*[\r\n]+[\s\S]*?```/gi, '').trim()}\n\n![${priorDiagram[1]}](${priorDiagram[2]})`;
      }
    }
    const nextContent = replaceMarkdownSection(currentContent, definition, nextDefinition, replacement);
    if (!nextContent) return { ok: false, detail: 'dokümanda bölüm sınırı bulunamadı; içerik korunuyor' };

    const storedSections = [...persistedSections];
    const storedIndex = storedSections.findIndex((section: any) => section?.key === definition.key);
    const storedSection = {
      ...(storedIndex >= 0 ? storedSections[storedIndex] : {}),
      key: definition.key,
      index: definition.index,
      screenIndex: definition.screenIndex,
      markdown: rawMarkdown,
      status: 'done',
      model,
      regeneratedAt: new Date().toISOString(),
    };
    if (storedIndex >= 0) storedSections[storedIndex] = storedSection;
    else storedSections.push(storedSection);
    const nextMetadata: Record<string, unknown> = {
      ...documentMetadata,
      content: nextContent,
      sections: storedSections,
      sectionRegeneratedAt: new Date().toISOString(),
    };
    if (definition.key === 'flow' && diagram?.xml) {
      nextMetadata.drawio_xml = diagram.xml;
      nextMetadata.drawio_source = diagram.source;
      nextMetadata.diagram_rendered = assembled.diagramRendered;
    }
    await this.prisma.documents.update({ where: { id: doc.id }, data: { metadata: nextMetadata as any } });
    await this.audit.log({
      actorType: 'user', action: 'update', entityType: 'documents', entityId: doc.id,
      summary: `Story #${story.id} doküman bölümü yeniden üretildi (${definition.key})`,
    });
    return { ok: true, docId: doc.id };
  }

  @Roles('consultant')
  @Patch('projects/:id/documents/:docId')
  async updateStoryDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Body() body: { content?: string },
  ) {
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    if (typeof body?.content !== 'string') return { ok: false, detail: 'content gerekli' };
    if (Buffer.byteLength(body.content, 'utf8') > 50 * 1024 * 1024) {
      return { ok: false, detail: 'content 50 MB sınırını aşıyor' };
    }
    const project = await (this.prisma as any).projects.findUnique({ where: { id }, select: { workspace_id: true } });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const doc = await this.prisma.documents.findFirst({ where: { id: docId, workspace_id: wsId, project_id: id } });
    const metadata = ((doc?.metadata as any) ?? {}) as Record<string, unknown>;
    if (!doc || metadata.doc_kind !== 'story_training_doc') return { ok: false, detail: 'eğitim dokümanı bulunamadı' };
    await this.prisma.documents.update({
      where: { id: doc.id },
      data: { metadata: { ...metadata, content: body.content, editedAt: new Date().toISOString() } as any },
    });
    await this.audit.log({
      actorType: 'user', action: 'update', entityType: 'documents', entityId: doc.id,
      summary: 'Eğitim dokümanı içeriği danışman tarafından düzenlendi',
    });
    return { ok: true, docId: doc.id };
  }

  @Roles('viewer')
  @Get('projects/:id/documents')
  async listProjectDocuments(@Param('id') id: string, @Query('kind') kind?: string) {
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    const project = await (this.prisma as any).projects.findUnique({ where: { id }, select: { workspace_id: true } });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const rows = await this.prisma.documents.findMany({
      where: { workspace_id: wsId, project_id: id },
      orderBy: { created_at: 'desc' },
      select: { id: true, title: true, metadata: true, created_at: true },
    });
    const requestedKind = String(kind ?? '').trim();
    const documents = rows.flatMap((row) => {
      const metadata = ((row.metadata as any) ?? {}) as Record<string, any>;
      if (requestedKind && metadata.doc_kind !== requestedKind) return [];
      const screenshotValue = metadata.screenshots;
      const screenshots = Array.isArray(screenshotValue)
        ? screenshotValue.length
        : Math.max(0, Number(screenshotValue ?? 0) || 0);
      const sections = (Array.isArray(metadata.sections) ? metadata.sections : []).map((section: any) => {
        const key = String(section?.key ?? '');
        const label = key === 'cover' ? 'Kapak ve meta'
          : key === 'purpose' ? 'Amaç ve ön koşullar'
            : key === 'concepts' ? 'Temel kavramlar'
              : key === 'flow' ? 'Süreç akışı'
                : key === 'situations' ? 'Durumlar ve terimler'
                  : key.startsWith('step-') ? `Adım ${key.slice(5)}` : key;
        return { key, index: Number(section?.index ?? 0) || null, label };
      }).filter((section: any) => Boolean(section.key));
      return [{
        docId: row.id,
        title: row.title,
        wid: metadata.ado?.id != null ? String(metadata.ado.id) : null,
        surum: String(metadata.meta?.surum ?? ''),
        screenshots,
        has_diagram: Boolean(metadata.drawio_xml),
        generatedAt: String(metadata.generatedAt ?? row.created_at.toISOString()),
        htmlPath: `/story-docs/${row.id}/html`,
        pdfPath: `/story-docs/${row.id}/pdf`,
        content: String(metadata.content ?? ''),
        sections,
      }];
    });
    return { ok: true, documents };
  }

  // ── Story Geliştirme Asistanı (enrichment) ─────────────────────────────────
  // Develops a user story from its FULL context, top-down:
  //   Epic → Feature (why the work exists)      ← fetchAncestors, the key input
  //   + project purpose (what this engagement is for)
  //   + product/tech stack (BC / F&SCM / web, custom apps, ISVs)
  //   + the story's own text, child tasks and comments (implementation detail)
  // A story's own text almost never states the business goal — its Epic/Feature
  // does — which is why an assistant reading only the story writes generic
  // filler. Nothing is written to ADO here; the caller reviews/edits and then
  // apply-content performs the audited write.
  private async enrichStory(project: any, wid: string): Promise<
    | { ok: true; story: { id: string; title: string }; context: any; draft: any }
    | { ok: false; detail: string }
  > {
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };
    const [children, comments, ancestors] = await Promise.all([
      fetchChildItems(project.devops_org, story).catch(() => []),
      fetchWorkItemComments(project.devops_org, wid, 10, { filterSelf: true }).catch(() => []),
      fetchAncestors(project.devops_org, story).catch(() => []),
    ]);
    const envContext = await buildEnvironmentContext(this.prisma, project.customer_id, project.id);

    // Ancestors come back nearest-first; present them top-down (Epic → Feature)
    // so the model reads the goal before the detail.
    const chain = [...ancestors].reverse();
    const ancestorBlock = chain.length
      ? `=== ÜST BAĞLAM (Epic → Feature — işin NEDEN yapıldığı) ===\n${chain
          .map((a) => `[${a.type}] #${a.id} ${a.title}${a.descriptionFull ? `\n    ${a.descriptionFull.slice(0, 1200)}` : ''}`)
          .join('\n')}\n\n`
      : '';
    const purpose = String(project.purpose ?? '').trim();
    const purposeBlock = purpose ? `=== PROJENİN AMACI ===\n${purpose.slice(0, 2000)}\n\n` : '';

    const body =
      `MÜŞTERİ: ${project.customer?.name ?? '?'} · PROJE: ${project.name}\n\n` +
      purposeBlock +
      ancestorBlock +
      (envContext ? `${envContext}\n\n` : '') +
      `=== GELİŞTİRİLECEK USER STORY ===\n#${story.id} — ${story.title} [${story.type}/${story.state}]\n` +
      `MEVCUT AÇIKLAMA: ${story.descriptionFull || '(boş)'}\n` +
      (story.acceptance ? `MEVCUT KABUL KRİTERLERİ: ${story.acceptance}\n` : '') +
      (children.length ? `\nALT GÖREVLER (${children.length}) — uygulama detayı:\n${children.map((c) => `- #${c.id} [${c.state}] ${c.title}${c.descriptionFull ? `: ${c.descriptionFull.slice(0, 300)}` : ''}`).join('\n')}\n` : '') +
      (comments.length ? `\nYORUMLAR:\n${comments.map((c) => `${c.by ?? '?'}: ${c.text.slice(0, 300)}`).join('\n')}\n` : '');

    let draft: any = null;
    for (const model of ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct']) {
      const data = await runAgent({
        run_id: `story-enrich-${wid}-${model.includes('70b') ? 'l' : 's'}-${Date.now()}`,
        workspace_id: project.workspace_id ?? undefined,
        ai_resource: {
          key: 'ai_story_enricher',
          name: 'AI Story Enricher',
          system_prompt:
            'Sen kıdemli bir D365 iş analistisin. Verilen user story\'yi ÜST BAĞLAMINDAN (Epic/Feature), PROJENİN AMACINDAN ve ÇÖZÜM YIĞINININ (platform/özel uygulama/ISV) ışığında GELİŞTİR. ' +
            'Story\'nin mevcut metni varsa koru ve zenginleştir, yoksa sıfırdan yaz. Epic/Feature\'daki iş hedefini story seviyesine indir; bu story o hedefin HANGİ parçasını karşılıyor, açıkça yaz. ' +
            'Kullanılan ürüne özgü ol (BC/F&SCM/web, ISV adları) — bağlamda geçmeyen ürün/modül adı UYDURMA. Uydurma kayıt numarası/tarih yazma; bilinmeyeni "örn." ile işaretle. Tamamen Türkçe yaz (D365 alan/menü adları İngilizce kalabilir).\n' +
            'draft.content alanına, AYNEN aşağıdaki başlıkları kullanarak düz metin yaz (JSON DEĞİL, başlıkları birebir kopyala):\n' +
            '## ACIKLAMA\n(2-4 paragraf: iş ihtiyacı, kapsam, etkilenen süreç/ürün)\n' +
            // NB: don't hand the model an ellipsis "pattern" here — it appends
            // it literally to every line ("... doğrulandığında") and the text
            // ships to ADO that way. Give a full example sentence instead.
            '## KABUL\n(3-6 ÖLÇÜLEBİLİR madde, her satır "- " ile başlar. Her madde TAM ve dilbilgisel olarak eksiksiz bir cümle olsun; doğrulanabilir bir sonucu anlatsın. Örnek: "Kullanıcı Report Centre ekranından seçtiği dönem için raporu Excel olarak dışa aktarabilir." Maddenin sonuna kalıp/ek ifade ekleme.)\n' +
            '## DEGER\n(1-2 cümle: Epic/Feature hedefine katkısı)\n' +
            '## KAPSAM_DISI\n(0-3 madde, her satır "- " ile başlar)\n' +
            '## SORULAR\n(danışmanın müşteriye sorması gereken 0-4 net soru, her satır "- " ile başlar)\n' +
            '## GOREVLER\n(0-5 alt görev başlığı, her satır "- " ile başlar)\n' +
            'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun; yukarıdaki başlıklı METNİN TAMAMINI draft.content alanına koy:\n' +
            '{"draft":{"kind":"note","subject":null,"content":"<BAŞLIKLI METİN BURAYA>","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
            'JSON dışında hiçbir metin yazma.',
          provider: 'nvidia',
          model,
          temperature: 0.3,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: { id: `se-${Date.now()}`, channel: 'manual', subject: `${story.title} — story geliştirme`, body, priority: 'normal', customer: null },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      });
      if (data) {
        const parsed = parseEnrichment(data?.draft?.content);
        if (parsed) { draft = parsed; break; }
      }
      this.logger.warn(`enrich #${wid}: ${model} başarısız/ayrıştırılamadı — sıradaki model`);
    }
    if (!draft) return { ok: false, detail: 'taslak üretilemedi — tekrar deneyin' };

    return {
      ok: true,
      story: { id: story.id, title: story.title },
      // Surfaced so the reviewer can see WHICH context shaped the draft — and
      // notice when the real gap is a missing Epic link or an unset purpose.
      context: {
        ancestors: chain.map((a) => ({ id: a.id, type: a.type, title: a.title })),
        hasPurpose: Boolean(purpose),
        hasStack: envContext.includes('ÇÖZÜM YIĞINI'),
        children: children.length,
      },
      draft,
    };
  }

  @Roles('consultant')
  @Post('projects/:id/stories/:wid/enrich')
  async enrich(@Param('id') id: string, @Param('wid') wid: string) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const res = await this.enrichStory(project, wid);
    if (res.ok) {
      await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'projects', entityId: id, summary: `Story #${wid} AI ile geliştirildi (taslak — ADO'ya yazılmadı)` });
    }
    return res;
  }

  // ── Toplu geliştirme: projedeki ZAYIF story'lerin hepsi ───────────────────
  // Each story costs a 70B call (~1-2 min), so a synchronous request would time
  // out long before a 20-story sweep finishes. The sweep therefore runs
  // detached, writing progress to projects.metadata.enrich_run and parking each
  // draft as a document for review. Nothing reaches ADO without a human
  // pressing apply on that draft.
  @Roles('consultant')
  @Post('projects/:id/stories/enrich-bulk')
  async enrichBulk(@Param('id') id: string, @Body() body?: { limit?: number; maxScore?: number; states?: string[] }) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };

    const meta = (project.metadata as any) ?? {};
    const running = meta.enrich_run;
    if (running && !running.finishedAt) {
      return { ok: false, detail: `zaten çalışıyor (${running.done}/${running.total}) — bitmesini bekleyin`, run: running };
    }
    const audit = meta.story_audit;
    if (!audit?.rows?.length) return { ok: false, detail: 'önce "User story analizi" çalıştırın (zayıf story listesi ondan geliyor)' };

    const maxScore = Math.min(Math.max(Number(body?.maxScore ?? 50), 1), 100);
    const limit = Math.min(Math.max(Number(body?.limit ?? 10), 1), 25); // hard cap: free-tier NIM quota
    // Status filter (empty = every state) — mirrors the chips on the board so
    // "develop the New ones" is expressible, not just "develop the weakest".
    const wanted = (body?.states ?? []).map((s) => String(s).toLowerCase()).filter(Boolean);
    const targets = (audit.rows as any[])
      .filter((r) => Number(r.score ?? 0) < maxScore)
      .filter((r) => !wanted.length || wanted.includes(String(r.state || '—').toLowerCase()))
      .sort((a, b) => Number(a.score ?? 0) - Number(b.score ?? 0))
      .slice(0, limit);
    const scope = wanted.length ? ` (durum: ${body!.states!.join(', ')})` : '';
    if (!targets.length) return { ok: false, detail: `puanı ${maxScore} altında story yok${scope} — geliştirilecek bir şey görünmüyor` };

    const run = { startedAt: new Date().toISOString(), finishedAt: null as string | null, total: targets.length, done: 0, failed: 0, maxScore, states: body?.states ?? [], drafts: [] as any[] };
    await (this.prisma as any).projects.update({ where: { id }, data: { metadata: { ...meta, enrich_run: run } } });

    // Detached sweep. tenantStore is re-entered explicitly: the HTTP request
    // that carried the tenant context has already returned by then.
    const wsId = currentWorkspaceId();
    void tenantStore.run({ workspaceId: wsId as string }, async () => {
      for (const t of targets) {
        try {
          const res = await this.enrichStory(project, String(t.id));
          if (res.ok) {
            const doc = await this.prisma.documents.create({
              data: {
                workspace_id: project.workspace_id ?? undefined,
                title: `#${t.id} ${res.story.title} — Story Geliştirme Taslağı`.slice(0, 400),
                source_type: 'agent_draft',
                mime_type: 'application/json',
                status: 'uploaded',
                customer_id: project.customer_id ?? undefined,
                project_id: project.id,
                metadata: {
                  doc_kind: 'story_enrichment',
                  wid: String(t.id),
                  story: res.story,
                  context: res.context,
                  draft: res.draft,
                  previousScore: t.score ?? null,
                  generatedAt: new Date().toISOString(),
                },
              },
            });
            run.drafts.push({ wid: String(t.id), title: res.story.title, docId: doc.id, previousScore: t.score ?? null });
          } else {
            run.failed++;
          }
        } catch (e) {
          run.failed++;
          this.logger.warn(`enrich-bulk #${t.id}: ${(e as Error).message}`);
        }
        run.done++;
        // Persist after every story so the UI can follow along and a crash
        // mid-sweep still leaves the completed drafts reviewable.
        const fresh = await (this.prisma as any).projects.findUnique({ where: { id }, select: { metadata: true } });
        await (this.prisma as any).projects.update({
          where: { id },
          data: { metadata: { ...((fresh?.metadata as any) ?? {}), enrich_run: run } },
        }).catch(() => {});
      }
      run.finishedAt = new Date().toISOString();
      const fresh = await (this.prisma as any).projects.findUnique({ where: { id }, select: { metadata: true } });
      await (this.prisma as any).projects.update({
        where: { id },
        data: { metadata: { ...((fresh?.metadata as any) ?? {}), enrich_run: run } },
      }).catch(() => {});
      await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'projects', entityId: id, summary: `Toplu story geliştirme: ${run.drafts.length} taslak hazır, ${run.failed} başarısız (${run.total} story)` });
    });

    return { ok: true, started: true, total: targets.length, detail: `${targets.length} story${scope} arka planda geliştiriliyor — taslaklar hazır oldukça listelenecek` };
  }

  // Progress + the drafts waiting for review.
  @Roles('consultant')
  @Get('projects/:id/enrich-run')
  async enrichRun(@Param('id') id: string) {
    // Tenant guard (IDOR): findUnique by primary key bypasses tenant
    // middleware, and the draft list below is otherwise project-scoped only —
    // both would leak another workspace's runs/drafts without this check.
    const wsId = currentWorkspaceId();
    if (!wsId) return { ok: false, detail: 'workspace bağlamı gerekli' };
    const project = await (this.prisma as any).projects.findUnique({ where: { id }, select: { workspace_id: true, metadata: true } });
    if (!project || project.workspace_id !== wsId) return { ok: false, detail: 'proje bulunamadı' };
    const run = ((project?.metadata as any) ?? {}).enrich_run ?? null;
    const pending = await this.prisma.documents.findMany({
      where: { workspace_id: wsId, project_id: id, status: 'uploaded', source_type: 'agent_draft' },
      orderBy: { created_at: 'desc' },
      take: 40,
      select: { id: true, title: true, metadata: true, created_at: true },
    });
    return {
      ok: true,
      run,
      drafts: pending
        .filter((d) => ((d.metadata as any) ?? {}).doc_kind === 'story_enrichment')
        .map((d) => ({ docId: d.id, title: d.title, ...((d.metadata as any) ?? {}) })),
    };
  }

  @Roles('consultant')
  @Post('projects/:id/stories/:wid/apply-content')
  async applyContent(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: { description?: string; acceptance?: string[] | string; docId?: string },
  ) {
    const project = await (this.prisma as any).projects.findUnique({ where: { id } });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const description = String(body?.description ?? '').trim();
    const acceptanceList = (Array.isArray(body?.acceptance) ? body.acceptance : String(body?.acceptance ?? '').split('\n'))
      .map((s) => String(s).trim()).filter(Boolean);
    if (!description && !acceptanceList.length) return { ok: false, detail: 'description veya acceptance gerekli' };

    // ADO rich-text fields are HTML: escape, then <br/> line breaks.
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const toHtml = (s: string) => `<div>${esc(s).replace(/\n/g, '<br/>')}</div>`;
    const conn = { id: 'inline', type: 'ado_org', name: `ADO: ${project.devops_org}`, config: { org: project.devops_org }, isMock: false } as any;
    const res = await devOpsAdapter.execute('devops_update_workitem' as any, {
      workItemId: wid,
      ...(description ? { description: toHtml(description) } : {}),
      ...(acceptanceList.length ? { acceptance: `<div>${acceptanceList.map(esc).join('<br/>')}</div>` } : {}),
    }, conn);
    if (!res.ok) return { ok: false, detail: res.detail };
    // Applied bulk drafts leave the review queue (status flips to processed).
    if (body?.docId) {
      const doc = await this.prisma.documents.findFirst({ where: { id: body.docId, project_id: id } });
      if (doc) {
        await this.prisma.documents.update({
          where: { id: doc.id },
          data: { status: 'processed' as any, metadata: { ...((doc.metadata as any) ?? {}), appliedAt: new Date().toISOString() } },
        }).catch(() => {});
      }
    }
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'projects', entityId: id, summary: `Story #${wid} içeriği AI taslağıyla dolduruldu (kullanıcı onaylı; açıklama ${description.length} kr, ${acceptanceList.length} kabul kriteri)` });
    return { ok: true, id: wid };
  }

  // ── Print-ready HTML (mermaid + cover + tables) ────────────────────────────
  // Viewer-level access; the workspace filter is MANDATORY — without a tenant
  // context we refuse rather than silently widening the query (IDOR guard).
  @Roles('viewer')
  @Get('story-docs/:docId/html')
  async html(@Param('docId') docId: string, @Res() res: Response) {
    const wsId = currentWorkspaceId();
    if (!wsId) {
      res.status(401).send('unauthorized');
      return;
    }
    const doc = await this.prisma.documents.findFirst({ where: { id: docId, workspace_id: wsId } });
    const meta = (doc?.metadata as any) ?? {};
    if (!doc || !meta.content) {
      res.status(404).send('doküman bulunamadı');
      return;
    }
    const project = doc.project_id ? await (this.prisma as any).projects.findUnique({ where: { id: doc.project_id }, include: { customer: { select: { name: true } } } }) : null;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // Defense-in-depth for a page rendering model-generated markdown: script
    // runs only from the pinned mermaid CDN or with THIS response's nonce —
    // no 'unsafe-inline', so an injected inline handler cannot execute even if
    // escaping ever regresses. Images limited to self/data/https.
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('content-security-policy',
      `default-src 'self'; img-src 'self' data: https:; script-src https://cdn.jsdelivr.net 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'`);
    res.send(renderDocHtml({
      title: doc.title,
      customer: project?.customer?.name ?? undefined,
      project: project?.name ?? undefined,
      adoRef: meta.ado ? `${meta.ado.org}/${meta.ado.project} #${meta.ado.id}` : undefined,
      markdown: String(meta.content),
      generatedAt: String(meta.generatedAt ?? doc.created_at.toISOString()),
      meta: meta.meta ?? undefined,
      nonce,
    }));
  }

  // PDF is rendered on demand and streamed directly; v1 intentionally does
  // not store a second binary document row. It uses the exact same tenant
  // guard and source metadata as the browser HTML endpoint.
  @Roles('viewer')
  @Get('story-docs/:docId/pdf')
  async pdf(@Param('docId') docId: string, @Res() res: Response) {
    const wsId = currentWorkspaceId();
    if (!wsId) {
      res.status(401).send('unauthorized');
      return;
    }
    const doc = await this.prisma.documents.findFirst({ where: { id: docId, workspace_id: wsId } });
    const meta = (doc?.metadata as any) ?? {};
    if (!doc || !meta.content) {
      res.status(404).send('doküman bulunamadı');
      return;
    }
    const project = doc.project_id
      ? await (this.prisma as any).projects.findUnique({
          where: { id: doc.project_id },
          include: { customer: { select: { name: true } } },
        })
      : null;
    const nonce = randomBytes(16).toString('base64');
    const html = renderDocHtml({
      title: doc.title,
      customer: project?.customer?.name ?? undefined,
      project: project?.name ?? undefined,
      adoRef: meta.ado ? `${meta.ado.org}/${meta.ado.project} #${meta.ado.id}` : undefined,
      markdown: String(meta.content),
      generatedAt: String(meta.generatedAt ?? doc.created_at.toISOString()),
      meta: meta.meta ?? undefined,
      mode: 'pdf',
      nonce,
    });

    let rendered: globalThis.Response | null = null;
    let renderError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        rendered = await fetch(`${SHOTTER_URL.replace(/\/+$/, '')}/render-pdf`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
          body: JSON.stringify({
            html,
            footerLeft: `${String(meta.ado?.title ?? doc.title)} · DYNAMICSOPS`,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        if (rendered.status !== 429 || attempt === 2) break;
        await rendered.text().catch(() => '');
        await wait(750 * 2 ** attempt);
      } catch (error) {
        renderError = error as Error;
        break;
      }
    }
    if (!rendered?.ok) {
      if (rendered) await rendered.text().catch(() => '');
      this.logger.warn(`PDF render failed for ${docId}: ${renderError?.message ?? `shotter ${rendered?.status ?? 'unreachable'}`}`);
      res.status(rendered?.status === 429 ? 503 : 502).send('PDF oluşturulamadı');
      return;
    }

    const pdf = Buffer.from(await rendered.arrayBuffer());
    const workItemId = String(meta.ado?.id ?? doc.id).replace(/[\r\n/\\?%*:|"<>]+/g, '-').slice(0, 120);
    const asciiName = `egitim-${safeFilePart(workItemId)}.pdf`;
    const unicodeName = `eğitim-${workItemId || 'doküman'}.pdf`;
    res.status(200);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', String(pdf.length));
    res.setHeader('content-disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${rfc5987(unicodeName)}`);
    res.send(pdf);
  }
}
