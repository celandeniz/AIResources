// User-story governance: (1) score every story's description sufficiency,
// (2) detect whether customer documentation was delivered (attachments /
// doc-ish links / comment signals), (3) auto-generate the customer-deliverable
// training document (senior-consultant format: amaç/ön koşullar/mermaid süreç
// diyagramı/adım adım gerçek örnek/sık hatalar) and optionally announce it
// back on the ADO work item.

import { Body, Controller, Get, Logger, Param, Post, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { AuditService } from '../../common/audit.service';
import { currentWorkspaceId } from '../../common/tenant';
import {
  devOpsAdapter, devopsConfigured, fetchChildItems, fetchUserStories, fetchWorkItemComments, fetchWorkItemFull,
} from '../../integrations/devops/devops.adapter';
import { renderDocHtml } from './doc-html';
import { PLATFORM_LABEL, buildEnvironmentContext, captureEnvironmentShots, type ShotSpec } from '../environments/environments.module';
import { getFileContent } from '../../integrations/github/github.adapter';
import { extractKeywords, findRelevantFiles, type RepoProfile } from './repo-profile';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

const DOC_SIGNAL_RE = /(dok[uü]man|documentation|training|e[ğg]itim|kullan[ıi]m k[ıi]lavuzu|user guide|\.(pdf|docx?|pptx?)\b|sharepoint\.com)/i;

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
  async planDoc(@Param('id') id: string, @Param('wid') wid: string, @Body() reqBody?: { force?: boolean }) {
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
          'yontem: dokümanın nasıl ilerleyeceği (4-6 madde, Türkçe); veriseti: hangi örnek kayıt/verilerle anlatılacağı (2-4 madde); ekranlar: en fazla 4 ekran, her biri platform alanı taşır; onkosullar: doküman için gerekenler. JSON dışında hiçbir metin yazma.',
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
      ekranlar: (plan.ekranlar ?? []).slice(0, 4),
      onkosullar: plan.onkosullar ?? [],
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

  // ── Generate the customer-deliverable training doc for one story ───────────
  // With planDocId (phase 2): executes the APPROVED plan — its screens feed
  // the shotter directly and its method/dataset steer the writing.
  @Roles('consultant')
  @Post('projects/:id/stories/:wid/doc')
  async generateDoc(@Param('id') id: string, @Param('wid') wid: string, @Body() body: { deliver?: boolean; planDocId?: string }) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };
    const comments = await fetchWorkItemComments(project.devops_org, wid, 15, { filterSelf: true }).catch(() => []);
    const docChildren = await fetchChildItems(project.devops_org, story).catch(() => []);

    // Approved plan (phase 2): its method/dataset steer the writing; its
    // screens are captured verbatim (no ad-hoc planning).
    let approvedPlan: any = null;
    if (body?.planDocId) {
      const planDoc = await this.prisma.documents.findFirst({ where: { id: body.planDocId } });
      approvedPlan = (planDoc?.metadata as any)?.plan ?? null;
    }

    // Ground the document in the customer's REAL discovered environments +
    // the project's tech stack (repos/ISVs) — senior-consultant behaviour.
    const envContext = await buildEnvironmentContext(this.prisma, project.customer_id, project.id);

    // Story-matched code excerpts (≤3 files, ~6k kr cap) from the project's
    // cached repo profiles — real implementation detail feeds the writing.
    let codeBlock = '';
    try {
      const profiles = (((project.metadata as any)?.repo_profile?.repos ?? []) as RepoProfile[]);
      if (profiles.length) {
        const keywords = extractKeywords(`${story.title} ${story.descriptionFull ?? ''}`);
        const files = findRelevantFiles(profiles, keywords, 3);
        const parts: string[] = [];
        let budget = 6000;
        for (const f of files) {
          const raw = await getFileContent(f.repo, f.path, 40_000);
          if (!raw) continue;
          const excerpt = raw.split('\n').slice(0, 400).join('\n').slice(0, Math.min(2500, budget));
          if (!excerpt.trim()) continue;
          budget -= excerpt.length;
          parts.push(`--- ${f.repo}/${f.path} ---\n${excerpt}`);
          if (budget <= 0) break;
        }
        if (parts.length) codeBlock = `=== İLGİLİ KOD (repo — gerçek uygulama detayı) ===\n${parts.join('\n\n')}\n\n`;
      }
    } catch { /* best-effort */ }

    const planBlock = approvedPlan
      ? `=== ONAYLANMIŞ PLAN (dokümanı BU plana göre yaz) ===\n` +
        `Platform: ${approvedPlan.platform} · Ortam: ${approvedPlan.ortam ?? '-'} · Şirket: ${approvedPlan.sirket ?? '-'} · Modül: ${approvedPlan.modul ?? '-'}\n` +
        `Yöntem:\n${(approvedPlan.yontem ?? []).map((m: string) => `- ${m}`).join('\n')}\n` +
        `Veri seti:\n${(approvedPlan.veriseti ?? []).map((m: string) => `- ${m}`).join('\n')}\n\n`
      : '';

    const context =
      `MÜŞTERİ: ${project.customer?.name ?? project.name}\nPROJE: ${project.name} (ADO: ${project.devops_org}/${project.devops_project})\n` +
      `İŞ KALEMİ: #${story.id} — ${story.title} [${story.type}/${story.state}]${story.assignee ? ` — sorumlu: ${story.assignee}` : ''}\n\n` +
      planBlock +
      (envContext ? `${envContext}\n\n` : '') +
      codeBlock +
      `=== AÇIKLAMA ===\n${story.descriptionFull || '(boş)'}\n\n` +
      (story.acceptance ? `=== KABUL KRİTERLERİ ===\n${story.acceptance}\n\n` : '') +
      (docChildren.length
        ? `=== ALT GÖREVLER (${docChildren.length}) — uygulama detayı buradan ===\n${docChildren.map((c) => `- #${c.id} [${c.state}] ${c.title}${c.descriptionFull ? `: ${c.descriptionFull.slice(0, 500)}` : ''}`).join('\n')}\n\n`
        : '') +
      (comments.length ? `=== YORUMLAR ===\n${comments.map((c) => `${c.by ?? '?'}: ${c.text.slice(0, 400)}`).join('\n')}\n` : '');

    // Two-part generation: each half fits comfortably in the output window and
    // the free tier's throughput, and each section gets more room for depth.
    const RULES =
      'KURALLAR: Story açıklaması zayıfsa bile alan bilginle senaryoyu D365 standart süreçlerine dayandırarak doldur; uydurma kayıt numarası yazma, örnek değerleri "örn." diye işaretle; tamamen Türkçe yaz (D365 alan/menü adları İngilizce kalabilir).\n' +
      'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun, markdown metnin TAMAMINI draft.content alanına koy:\n' +
      '{"draft":{"kind":"note","subject":null,"content":"<TÜM MARKDOWN DOKÜMAN BURAYA>","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
      'JSON dışında hiçbir metin yazma.';
    // Model ladder: the 70B writer first; when the free-tier gateway is
    // congested (5xx/timeout → degraded response), fall back to the fast 8B so
    // the document still ships (model is recorded in metadata).
    const DOC_MODELS = (process.env.DOC_MODELS ?? 'meta/llama-3.3-70b-instruct,meta/llama-3.1-8b-instruct')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const callPart = async (partPrompt: string, tag: string) => {
      for (const model of DOC_MODELS) {
        const data = await runAgent({
          run_id: `story-doc-${wid}-${tag}-${Date.now()}`,
          workspace_id: project.workspace_id ?? undefined,
          ai_resource: {
            key: 'ai_doc_writer',
            name: 'AI Doc Writer',
            system_prompt: 'Sen Dynamics 365 (BC/F&O) alanında kıdemli bir danışmansın ve müşteriye teslim edilecek eğitim/süreç dokümanı yazıyorsun. ' + partPrompt + '\n' + RULES,
            provider: 'nvidia',
            model,
            temperature: 0.35,
            tools: [],
            confidence_threshold: 0.5,
          },
          activity: { id: `sd-${tag}-${Date.now()}`, channel: 'manual', subject: `${story.title} — eğitim dokümanı`, body: context, priority: 'normal', customer: null },
          context: { thread: [], rag_hints: [], rag_hits: [] },
          options: { max_tool_intents: 0 },
        });
        if (data && String(data?.draft?.content ?? '').trim().length >= 200) return data;
        this.logger.warn(`story-doc ${tag}: ${model} başarısız — sıradaki model deneniyor`);
      }
      return null;
    };

    const part1 = await callPart(
      'draft.content alanına dokümanın İLK YARISINI markdown olarak yaz — SADECE şu bölümler:\n' +
      '# <Doküman başlığı>\n' +
      '## 1. Amaç ve Kapsam\n(iş senaryosu, hangi süreç, kimin için; 1 markdown tablo ile Ortam/Modül/İlgili kayıt özetini ver; bağlamda ÇÖZÜM YIĞINI verildiyse "### 1.1 Çözüm Bileşenleri" alt başlığında Platform | Bileşen (Uygulama/ISV) | Yayıncı/Sürüm kolonlu bir markdown tablosu ekle — SADECE bağlamdaki gerçek bileşenleri listele)\n' +
      '## 2. Ön Koşullar ve Kurulum\n(gerekli parametreler, roller, ana veriler — D365 menü yolları ile: örn. "Sales & Marketing > Setup > ..."; alt başlıklar 2.1, 2.2 kullan; ekran görüntüsü gereken yerlere "📷 [Ekran görüntüsü: <ne gösterilecek>]" satırı koy)\n' +
      '## 3. Süreç Akışı\n(kısa giriş cümlesi + SADECE bir ```mermaid\\nflowchart TD``` bloğu — başlangıç/işlem/karar/bitiş düğümleriyle süreci çiz; düğüm metinleri Türkçe ve kısa, tırnak içinde)',
      'p1',
    );
    const md1 = String(part1?.draft?.content ?? '').trim();
    if (!md1 || md1.length < 200) return { ok: false, detail: 'doküman (bölüm 1-3) üretilemedi — tekrar deneyin' };

    const part2 = await callPart(
      'Dokümanın İLK YARISI (bölüm 1-3) zaten yazıldı. draft.content alanına İKİNCİ YARISINI markdown olarak yaz — SADECE şu bölümler:\n' +
      '## 4. Adım Adım Uygulama — Gerçek Örnek\n(Adım 1..N alt başlıklarıyla; her adımda D365 ekran/menü yolu, girilecek alanlar ve iş kaleminden gelen GERÇEK değerlerle somut örnek; muhasebe/veri etkisi varsa Borç/Alacak veya önce/sonra markdown tablosu; ekran görüntüsü gereken yerlere "📷 [Ekran görüntüsü: <ne gösterilecek>]" satırı)\n' +
      '## 5. Doğrulama ve Teslim Notları\n(nasıl test edilir, UAT önerisi, raporlama/izleme notları)\n' +
      '## 6. Sık Karşılaşılan Hatalar\n(en az 3 gerçekçi hata mesajı + nedeni + çözümü, madde madde)',
      'p2',
    );
    const md2 = String(part2?.draft?.content ?? '').trim();
    if (!md2 || md2.length < 200) return { ok: false, detail: 'doküman (bölüm 4-6) üretilemedi — tekrar deneyin' };

    let markdown = `${md1}\n\n${md2}`;
    const data = part2;

    // ── Live screenshots from the customer environment (best-effort) ─────────
    // A small model call plans up to 4 D365 deep links (menu item + company)
    // for this scenario; the shotter sidecar logs in with the env's UI service
    // account and captures them; images are embedded into the document.
    let shotCount = 0;
    try {
      // Approved plan carries the exact screens — skip ad-hoc planning.
      if (approvedPlan?.ekranlar?.length) {
        const shots = await captureEnvironmentShots(this.prisma, project.customer_id, approvedPlan.ekranlar as ShotSpec[], project.id);
        if (shots.length) {
          shotCount = shots.length;
          markdown += '\n\n## Ekran Görüntüleri (canlı ortamdan)\n' +
            shots.map((s, i) => `**Şekil ${i + 1} — ${s.caption}**\n\n![${s.caption}](${s.dataUri})`).join('\n\n');
        }
        throw { skipAdhoc: true };
      }
      const plan = await runAgent({
        run_id: `story-shots-${wid}-${Date.now()}`,
        workspace_id: project.workspace_id ?? undefined,
        ai_resource: {
          key: 'ai_shot_planner',
          name: 'AI Shot Planner',
          system_prompt:
            'Sen bir D365 Finance & SCM uzmanısın. Verilen senaryo için canlı ortamdan çekilecek en fazla 4 ekranı planla. ' +
            'Her ekran için D365 F&O menu item adı (URL mi= parametresi, örn. CustTableListPage, CustTable, SalesTableListPage, VendTableListPage, LedgerJournalTable5) ve kısa Türkçe başlık ver. ' +
            'Senaryoda şirket (örn. USMF) geçiyorsa cmp olarak onu kullan.\n' +
            'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun; content alanına SADECE plan dizisini string olarak koy:\n' +
            '{"draft":{"kind":"note","subject":null,"content":"[{\\"mi\\":\\"CustTableListPage\\",\\"cmp\\":\\"USMF\\",\\"caption\\":\\"Müşteri listesi\\"}]","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
            'JSON dışında hiçbir metin yazma.',
          provider: 'nvidia',
          model: 'meta/llama-3.1-8b-instruct',
          temperature: 0.1,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: { id: `sp-${Date.now()}`, channel: 'manual', subject: story.title, body: context.slice(0, 2500), priority: 'normal', customer: null },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      });
      let specs: ShotSpec[] = [];
      const planContent = String(plan?.draft?.content ?? '');
      try {
        specs = JSON.parse(planContent.slice(planContent.indexOf('['), planContent.lastIndexOf(']') + 1));
      } catch { /* plan yoksa ekran fazı atlanır */ }
      if (specs.length) {
        const shots = await captureEnvironmentShots(this.prisma, project.customer_id, specs, project.id);
        if (shots.length) {
          shotCount = shots.length;
          markdown += '\n\n## Ekran Görüntüleri (canlı ortamdan)\n' +
            shots.map((s, i) => `**Şekil ${i + 1} — ${s.caption}**\n\n![${s.caption}](${s.dataUri})`).join('\n\n');
        }
      }
    } catch (e) {
      if (!(e as any)?.skipAdhoc) this.logger.warn(`screenshot phase skipped: ${(e as Error).message}`);
    }

    // Mark the plan as executed and link the outcome.
    if (body?.planDocId) {
      await this.prisma.documents.update({
        where: { id: body.planDocId },
        data: { status: 'processed' as any, metadata: { plan: approvedPlan, doc_kind: 'story_doc_plan', executedAt: new Date().toISOString() } },
      }).catch(() => {});
    }

    const doc = await this.prisma.documents.create({
      data: {
        workspace_id: project.workspace_id ?? undefined,
        title: `${story.title} — Eğitim Dokümanı`.slice(0, 400),
        source_type: 'agent_draft',
        mime_type: 'text/markdown',
        status: 'uploaded',
        customer_id: project.customer_id ?? undefined,
        project_id: project.id,
        metadata: {
          content: markdown,
          doc_kind: 'story_training_doc',
          ado: { org: project.devops_org, project: project.devops_project, id: story.id, title: story.title },
          model: data?.model ?? null,
          screenshots: shotCount,
          generatedAt: new Date().toISOString(),
        },
      },
    });

    // Optional delivery announcement on the work item (auto-tier ADO comment).
    let delivered = false;
    if (body?.deliver !== false) {
      const conn = { id: 'inline', type: 'ado_org', name: `ADO: ${project.devops_org}`, config: { org: project.devops_org }, isMock: false } as any;
      const res = await devOpsAdapter.execute('devops_comment' as any, {
        workItemId: story.id,
        text: `📘 Müşteri eğitim dokümanı hazırlandı: "${doc.title}" (DynOps doc ${doc.id}). Platform üzerinden görüntülenebilir/PDF alınabilir.`,
      }, conn);
      delivered = Boolean(res.ok);
      await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'documents', entityId: doc.id, summary: `Story #${story.id} eğitim dokümanı üretildi${delivered ? ' + ADO bildirimi' : ''}` });
    }

    return { ok: true, docId: doc.id, title: doc.title, delivered, screenshots: shotCount, htmlPath: `/story-docs/${doc.id}/html` };
  }

  // ── Story İçerik Asistanı: AI drafts description + acceptance criteria ─────
  // Phase 1 (draft-content): NOTHING is written to ADO — the model proposes a
  // proper Turkish description + measurable acceptance criteria from the
  // title, existing scraps, CHILD TASKS, comments and the project's tech
  // context (ÇÖZÜM YIĞINI). Phase 2 (apply-content): the user reviewed/edited
  // the draft — the button click IS the human approval (same pattern as the
  // doc-delivery comment); the write is audited and the readiness gate can be
  // re-run immediately after.
  @Roles('consultant')
  @Post('projects/:id/stories/:wid/draft-content')
  async draftContent(@Param('id') id: string, @Param('wid') wid: string) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!project?.devops_org) return { ok: false, detail: 'proje ADO eşlemesi yok' };
    const story = await fetchWorkItemFull(project.devops_org, wid);
    if (!story) return { ok: false, detail: `iş kalemi #${wid} okunamadı` };
    const children = await fetchChildItems(project.devops_org, story).catch(() => []);
    const comments = await fetchWorkItemComments(project.devops_org, wid, 10, { filterSelf: true }).catch(() => []);
    const envContext = await buildEnvironmentContext(this.prisma, project.customer_id, project.id);

    const body =
      `İŞ KALEMİ: #${story.id} — ${story.title} [${story.type}]\n` +
      `MEVCUT AÇIKLAMA: ${story.descriptionFull || '(boş)'}\n` +
      (story.acceptance ? `MEVCUT KABUL KRİTERLERİ: ${story.acceptance}\n` : '') +
      (children.length ? `ALT GÖREVLER (${children.length}):\n${children.map((c) => `- #${c.id} [${c.state}] ${c.title}${c.descriptionFull ? `: ${c.descriptionFull.slice(0, 300)}` : ''}`).join('\n')}\n` : '') +
      (comments.length ? `YORUMLAR:\n${comments.map((c) => `${c.by ?? '?'}: ${c.text.slice(0, 300)}`).join('\n')}\n` : '') +
      (envContext ? `\n${envContext}\n` : '');

    let draft: { description: string; acceptance: string[] } | null = null;
    for (const model of ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct']) {
      const data = await runAgent({
        run_id: `story-fill-${wid}-${model.includes('70b') ? 'l' : 's'}-${Date.now()}`,
        workspace_id: project.workspace_id ?? undefined,
        ai_resource: {
          key: 'ai_story_filler',
          name: 'AI Story Filler',
          system_prompt:
            'Sen kıdemli bir D365 iş analistisin. Verilen user story için EKSİK olan açıklama ve kabul kriterlerini profesyonelce TASLAK olarak yaz. ' +
            'Başlık, alt görevler, yorumlar ve teknoloji bağlamından (platform/özel uygulama/ISV) yararlan; iş amacı + kapsam/etkilenen süreç + varsa veri/adım detayı içeren 2-4 paragraflık Türkçe açıklama üret. ' +
            'Kabul kriterleri ÖLÇÜLEBİLİR olsun (3-6 madde, her biri tek cümle, "…yapılabildiğinde/…doğrulandığında" kalıbında). Uydurma kayıt numarası/tarih yazma; bilinmeyeni "örn." ile işaretle.\n' +
            'ÇIKTI FORMATI — yanıtın TAMAMI şu tek JSON nesnesi olsun; content alanına SADECE taslak JSON\'unu string olarak koy:\n' +
            '{"draft":{"kind":"note","subject":null,"content":"{\\"description\\":\\"...açıklama metni...\\",\\"acceptance\\":[\\"kriter 1\\",\\"kriter 2\\"]}","recipients":[],"citations":[]},"reasoning_summary":"1 cümle","confidence":0.9,"needs_escalation":false,"escalate_to":null,"tool_intents":[]}\n' +
            'JSON dışında hiçbir metin yazma.',
          provider: 'nvidia',
          model,
          temperature: 0.3,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: { id: `sf-${Date.now()}`, channel: 'manual', subject: `${story.title} — içerik taslağı`, body, priority: 'normal', customer: null },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      });
      if (data) {
        const raw = data?.draft?.content;
        let parsed: any = null;
        if (raw && typeof raw === 'object' && (raw as any).description) parsed = raw;
        else {
          const content = String(raw ?? '');
          try { parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { /* next model */ }
        }
        if (parsed?.description) {
          draft = {
            description: String(parsed.description).slice(0, 4000),
            acceptance: (Array.isArray(parsed.acceptance) ? parsed.acceptance : []).map((a: any) => String(a).slice(0, 300)).slice(0, 8),
          };
          break;
        }
      }
      this.logger.warn(`draft-content: ${model} başarısız/ayrıştırılamadı — sıradaki model`);
    }
    if (!draft) return { ok: false, detail: 'taslak üretilemedi — tekrar deneyin' };
    await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'projects', entityId: id, summary: `Story #${story.id} için içerik taslağı üretildi (ADO'ya yazılmadı)` });
    return { ok: true, story: { id: story.id, title: story.title }, draft };
  }

  @Roles('consultant')
  @Post('projects/:id/stories/:wid/apply-content')
  async applyContent(
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: { description?: string; acceptance?: string[] | string },
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
      nonce,
    }));
  }
}
