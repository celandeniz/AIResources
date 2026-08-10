// Project Hub — every company project managed in sync across ADO + email +
// Teams, with a live per-project dashboard (status, this-week / next-week /
// this-month buckets, cross-channel feed).
//
// Provisioning: POST /projects/sync-cosmos upserts a projects row for every
// Cosmos DynOpsCore org × project (the same identity status/timelog reports
// use), auto-creating/linking the Postgres customers row. ADO/Teams/mail
// mappings are then curated per project (PATCH) and drive the attribution
// engine in project-resolver.ts.

import { Body, Controller, Get, Injectable, Logger, Module, OnModuleInit, Param, Patch, Post, Query } from '@nestjs/common';
import { bucketByDue, type DueBucket } from '@dynops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { AuditModule, AuditService } from '../../common/audit.service';
import { CosmosTimelogService } from '../../integrations/cosmos/timelog.service';
import { fetchAdoProjects, fetchOpenWorkItems, fetchRecentWorkItems, devopsConfigured } from '../../integrations/devops/devops.adapter';
import { discoverAllTeams, listTeamChannels } from '../../integrations/graph/graph-teams.adapter';
import { graphConfigured } from '../../integrations/graph/graph-client';
import { currentWorkspaceId, tenantStore } from '../../common/tenant';
import { invalidateProjectCache, resolveProject } from './project-resolver';
import { analyzeRepo, isvsFromProfile, type RepoProfile } from './repo-profile';
import { StoryDocsController } from './story-docs.controller';
import { buildEnvironmentContext } from '../environments/environments.module';

const ENABLE_PROJECT_HUB = process.env.ENABLE_PROJECT_HUB !== 'false';

// Cosmos → projects provisioning, shared by the controller endpoint and the
// daily background sync.
@Injectable()
export class ProjectSyncService implements OnModuleInit {
  private readonly logger = new Logger('ProjectSync');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cosmos: CosmosTimelogService,
  ) {}

  onModuleInit() {
    if (!ENABLE_PROJECT_HUB) {
      this.logger.log('Project Hub disabled (ENABLE_PROJECT_HUB=false).');
      return;
    }
    const run = () => this.syncAllWorkspaces().catch((e: Error) => this.logger.warn(`project sync failed: ${e.message}`));
    setInterval(run, 24 * 3_600_000);
    setTimeout(run, 45_000);
  }

  async syncAllWorkspaces() {
    const workspaces = await (this.prisma as any).workspaces.findMany({ select: { id: true } });
    for (const ws of workspaces) {
      await tenantStore.run({ workspaceId: ws.id }, async () => {
        await this.syncCosmos();
        await this.syncAdo().catch((e: Error) => this.logger.warn(`ado sweep failed: ${e.message}`));
      });
    }
  }

  // ADO sweep: for every live ado_org connection, (a) upsert projects rows for
  // ADO projects the platform doesn't know yet, and (b) refresh open-work-item
  // stats (count / overdue / state distribution) on EVERY mapped project so
  // the portfolio shows real numbers without visiting each dashboard.
  async syncAdo() {
    const summary: { org: string; project: string; open: number; overdue: number; created?: boolean }[] = [];
    if (!devopsConfigured()) return { ok: false, detail: 'ADO not configured', summary };
    const orgRows = await this.prisma.integrations.findMany({ where: { is_mock: false, type: 'ado_org' } });
    for (const row of orgRows) {
      const org = String(((row.config as any) ?? {}).org ?? '');
      if (!org) continue;
      const adoProjects = await fetchAdoProjects(org);
      for (const ap of adoProjects) {
        // Find-or-create the projects row for this ADO project.
        let project = await (this.prisma as any).projects.findFirst({
          where: { devops_org: org, devops_project: ap.name },
        });
        let created = false;
        if (!project) {
          // Reuse the org's customer (via an already-mapped sibling project),
          // else create a customer named after the org.
          const sibling = await (this.prisma as any).projects.findFirst({ where: { devops_org: org } });
          let customerId = sibling?.customer_id;
          if (!customerId) {
            const customer =
              (await this.prisma.customers.findFirst({ where: { name: org } })) ??
              (await this.prisma.customers.create({ data: { name: org, metadata: { source: 'ado-sync' } } }));
            customerId = customer.id;
          }
          project = await (this.prisma as any).projects.create({
            data: {
              customer_id: customerId,
              name: ap.name,
              description: `Azure DevOps projesi (${org})`,
              devops_org: org,
              devops_project: ap.name,
              metadata: { provisioned: 'ado-sync' },
            },
          });
          created = true;
        }
        // Refresh live stats.
        const items = await fetchOpenWorkItems(org, ap.name, 200).catch(() => []);
        const now = Date.now();
        const overdue = items.filter((w) => {
          const d = w.dueDate ?? w.targetDate;
          return d && new Date(d).getTime() < now;
        }).length;
        const byState = items.reduce((acc: Record<string, number>, w) => { acc[w.state] = (acc[w.state] ?? 0) + 1; return acc; }, {});
        await (this.prisma as any).projects.update({
          where: { id: project.id },
          data: {
            metadata: {
              ...((project.metadata as any) ?? {}),
              stats: { adoOpen: items.length, adoOverdue: overdue, byState, at: new Date().toISOString() },
            },
          },
        });
        summary.push({ org, project: ap.name, open: items.length, overdue, ...(created ? { created: true } : {}) });
      }
    }
    invalidateProjectCache();
    this.logger.log(`ADO sweep: ${summary.length} project(s), ${summary.filter((s) => s.created).length} new`);
    return { ok: true, projects: summary.length, created: summary.filter((s) => s.created).length, summary };
  }

  async syncCosmos() {
    const orgs = await this.cosmos.listOrganizations();
    let created = 0, seen = 0;
    for (const org of orgs) {
      let projectNames: string[] = [];
      try {
        projectNames = await this.cosmos.listProjects(org.org_name);
      } catch { continue; }
      if (!projectNames.length) continue;
      // Find-or-create the Postgres customer for this Cosmos org.
      let customer = await this.prisma.customers.findFirst({ where: { name: org.display_name } });
      if (!customer) {
        customer = await this.prisma.customers.create({
          data: { name: org.display_name, metadata: { cosmos_customer_id: org.id, cosmos_org_name: org.org_name } },
        });
      }
      for (const projectName of projectNames) {
        seen++;
        const existing = await (this.prisma as any).projects.findFirst({
          where: { cosmos_org_name: org.org_name, cosmos_project_name: projectName },
        });
        if (existing) continue;
        await (this.prisma as any).projects.create({
          data: {
            customer_id: customer.id,
            name: projectName,
            description: `Cosmos DynOpsCore project (${org.display_name})`,
            cosmos_org_name: org.org_name,
            cosmos_project_name: projectName,
            metadata: { cosmos_customer_id: org.id, provisioned: 'cosmos-sync' },
          },
        });
        created++;
      }
    }
    invalidateProjectCache();
    this.logger.log(`Cosmos project sync: ${created} created / ${seen} seen`);
    return { ok: true, created, seen, orgs: orgs.length };
  }
}

@Controller('projects')
export class ProjectsController {
  private readonly logger = new Logger('Projects');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sync: ProjectSyncService,
  ) {}

  @Get()
  async list() {
    const projects = await (this.prisma as any).projects.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: { customer: { select: { id: true, name: true, domain: true } } },
    });
    // Lightweight counts for portfolio cards (grouped queries, no N+1).
    const ids = projects.map((p: any) => p.id);
    const [openTasks, overdueTasks, missions, threads] = await Promise.all([
      this.prisma.tasks.groupBy({ by: ['project_id'], where: { project_id: { in: ids }, status: { in: ['open', 'in_progress'] } }, _count: true }),
      this.prisma.tasks.groupBy({ by: ['project_id'], where: { project_id: { in: ids }, status: { in: ['open', 'in_progress'] }, due_date: { lt: new Date() } }, _count: true }),
      (this.prisma as any).missions.groupBy({ by: ['project_id'], where: { project_id: { in: ids }, status: { in: ['planning', 'running', 'blocked'] } }, _count: true }),
      (this.prisma as any).coverage_threads.groupBy({ by: ['project_id'], where: { project_id: { in: ids }, state: { in: ['at_risk', 'stalled', 'escalated'] } }, _count: true }).catch(() => []),
    ]);
    const countOf = (rows: any[], id: string) => rows.find((r) => r.project_id === id)?._count ?? 0;
    return projects.map((p: any) => {
      // ADO open-item stats are cached on the row by the dashboard endpoint so
      // the portfolio stays cheap (no 21 REST calls per page load).
      const stats = ((p.metadata as any) ?? {}).stats ?? {};
      return {
        ...p,
        counts: {
          openItems: countOf(openTasks, p.id) + (stats.adoOpen ?? 0),
          overdue: countOf(overdueTasks, p.id) + (stats.adoOverdue ?? 0),
          runningMissions: countOf(missions, p.id),
          stalledThreads: countOf(threads as any[], p.id),
        },
        statsAt: stats.at ?? null,
      };
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, domain: true } } },
    });
  }

  @Roles('manager')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'status', 'devops_org', 'devops_project', 'teams_team_id', 'teams_channel_ids', 'teams_chat_ids', 'mail_keywords', 'lead_user_id', 'start_date', 'end_date', 'repos', 'isvs'] as const) {
      if (body[k] !== undefined) allowed[k] = body[k];
    }
    const row = await (this.prisma as any).projects.update({ where: { id }, data: allowed });
    invalidateProjectCache();
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'projects', entityId: id, summary: `Project mappings updated: ${Object.keys(allowed).join(', ')}` });
    return row;
  }

  // Upsert a projects row for every Cosmos org × project (mock Cosmos works keyless).
  @Roles('manager')
  @Post('sync-cosmos')
  syncCosmos() {
    return this.sync.syncCosmos();
  }

  // Full ADO sweep across all live orgs: upsert missing ADO projects + refresh
  // per-project open-item stats for the portfolio.
  @Roles('manager')
  @Post('sync-ado')
  syncAdo() {
    return this.sync.syncAdo();
  }

  // WS6: profile the project's repos (AL apps + dependencies→ISVs, X++
  // models, web framework) and merge env-discovered BC extensions into the
  // ISV list. Cached in metadata.repo_profile (rate-limit friendly — re-run
  // via the button, not automatically).
  @Roles('consultant')
  @Post(':id/analyze-repos')
  async analyzeRepos(@Param('id') id: string) {
    const project = await (this.prisma as any).projects.findUnique({ where: { id } });
    if (!project) return { ok: false, detail: 'proje bulunamadı' };
    const repos = ((project.repos as any[]) ?? []).filter((r: any) => r?.repo && r?.kind);
    if (!repos.length && !project.customer_id) return { ok: false, detail: 'projede tanımlı repo yok (Eşlemeler > Repolar)' };

    const profiles: RepoProfile[] = [];
    for (const r of repos.slice(0, 6)) {
      profiles.push(await analyzeRepo({ repo: String(r.repo), kind: r.kind, branch: r.branch }));
    }

    // ISV merge: manual entries are preserved; repo/env-derived entries are
    // refreshed (dedupe by folded name).
    const existing = ((project.isvs as any[]) ?? []);
    const manual = existing.filter((i: any) => (i.source ?? 'manual') === 'manual');
    const derived: { name: string; publisher?: string; source: string }[] = profiles.flatMap((p) => isvsFromProfile(p));
    if (project.customer_id) {
      const envs = await (this.prisma as any).customer_environments.findMany({
        where: { customer_id: project.customer_id },
        select: { metadata: true },
      });
      for (const e of envs) {
        for (const x of (((e.metadata as any)?.extensions ?? []) as any[])) {
          if (/^microsoft$/i.test(String(x.publisher ?? ''))) continue;
          derived.push({ name: String(x.displayName ?? '?'), publisher: x.publisher, source: 'env' });
        }
      }
    }
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = new Set(manual.map((i: any) => norm(String(i.name))));
    const merged = [...manual];
    for (const d of derived) {
      if (seen.has(norm(d.name))) continue;
      seen.add(norm(d.name));
      merged.push(d);
    }

    const repoProfile = {
      analyzedAt: new Date().toISOString(),
      repos: profiles.map((p) => ({ ...p, tree: p.tree.slice(0, 800) })), // cap stored path list
    };
    await (this.prisma as any).projects.update({
      where: { id },
      data: {
        isvs: merged,
        metadata: { ...((project.metadata as any) ?? {}), repo_profile: repoProfile },
      },
    });
    invalidateProjectCache();
    await this.audit.log({ actorType: 'user', action: 'execute', entityType: 'projects', entityId: id, summary: `Repo analizi: ${profiles.length} repo, ${profiles.reduce((n, p) => n + p.apps.length, 0)} uygulama, ${merged.length} ISV kaydı` });
    return {
      ok: true,
      repos: profiles.map((p) => ({ repo: p.repo, kind: p.kind, fileCount: p.fileCount, apps: p.apps, models: p.models, framework: p.framework, error: p.error ?? null })),
      isvs: merged,
    };
  }

  // Channel picker data for the mapping UI (needs Graph + Group.Read.All).
  @Roles('manager')
  @Get(':id/discover-channels')
  async discoverChannels(@Param('id') id: string, @Query('teamId') teamId?: string) {
    if (!graphConfigured()) return { connected: false, teams: [], channels: [] };
    if (teamId) return { connected: true, teams: [], channels: await listTeamChannels(teamId) };
    return { connected: true, teams: await discoverAllTeams(), channels: [] };
  }

  // Re-run project attribution over recent unattributed activities & threads.
  @Roles('manager')
  @Post(':id/reattribute')
  async reattribute(@Param('id') id: string, @Body() body: { days?: number }) {
    const since = new Date(Date.now() - Math.min(body?.days ?? 90, 365) * 86_400_000);
    const wsKey = currentWorkspaceId() ?? 'default';
    invalidateProjectCache();
    const candidates = await this.prisma.activities.findMany({
      where: { project_id: null, received_at: { gte: since } },
      select: { id: true, subject: true, customer_id: true, channel: true, metadata: true },
      take: 1000,
    });
    let stamped = 0;
    for (const a of candidates) {
      const meta = (a.metadata as any) ?? {};
      const pid = await resolveProject(this.prisma, wsKey, {
        customer_id: a.customer_id,
        adoOrg: meta.ado?.org ?? null,
        adoProject: meta.ado?.project ?? null,
        teamId: meta.team_id ?? null,
        channelId: meta.channel_id ?? null,
        subject: a.subject,
      });
      if (pid === id) {
        await this.prisma.activities.update({ where: { id: a.id }, data: { project_id: pid } });
        stamped++;
      }
    }
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'projects', entityId: id, summary: `Reattribution: ${stamped}/${candidates.length} activities stamped` });
    return { ok: true, scanned: candidates.length, stamped };
  }

  // Role-based to-do brief: gathers live ADO open items + stalled coverage
  // threads + recent activity, and asks the delivery-PM resource (NIM) to
  // produce concrete action lists for PM / lead consultant / developer.
  // Cached in projects.metadata.brief; regenerate with POST.
  @Roles('consultant')
  @Post(':id/brief')
  async generateBrief(@Param('id') id: string) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { name: true } } },
    });
    if (!project) return null;

    let adoItems: any[] = [];
    if (devopsConfigured() && project.devops_org && project.devops_project) {
      adoItems = await fetchOpenWorkItems(project.devops_org, String(project.devops_project), 100).catch(() => []);
    }
    const [threads, feed, openTasks] = await Promise.all([
      (this.prisma as any).coverage_threads.findMany({
        where: { project_id: id, state: { in: ['at_risk', 'stalled', 'escalated'] } },
        select: { subject: true, counterpart: true, stalled_reason: true, last_inbound_at: true },
        take: 20,
      }).catch(() => []),
      this.prisma.activities.findMany({
        where: { project_id: id },
        select: { subject: true, channel: true, status: true, received_at: true },
        orderBy: { received_at: 'desc' },
        take: 15,
      }),
      this.prisma.tasks.findMany({
        where: { project_id: id, status: { in: ['open', 'in_progress'] } },
        select: { title: true, priority: true, due_date: true },
        take: 30,
      }),
    ]);

    // Compact: prioritise Active + stalest items, cap 60 lines, short titles —
    // keeps the prompt small so the 4k output window is spent on the answer.
    const ranked = [...adoItems].sort((a, b) => {
      const act = (w: any) => (/active|doing|progress/i.test(w.state) ? 0 : 1);
      return act(a) - act(b) || String(a.changedDate ?? '').localeCompare(String(b.changedDate ?? ''));
    }).slice(0, 40);
    const itemLines = ranked.map((w) =>
      `#${w.id} [${w.type}/${w.state}] ${String(w.title).slice(0, 80)}${w.assignee ? ` — ${w.assignee}` : ' — ATANMAMIŞ'}${w.dueDate ?? w.targetDate ? ` — hedef ${(w.dueDate ?? w.targetDate).slice(0, 10)}` : ''}${w.changedDate ? ` — son ${w.changedDate.slice(0, 10)}` : ''}`,
    );
    const threadLines = (threads as any[]).map((t) => `${t.counterpart ?? '?'}: "${t.subject ?? ''}" (${t.stalled_reason})`);
    const envContext = await buildEnvironmentContext(this.prisma, project.customer_id);
    const body =
      `PROJE: ${project.name} (müşteri: ${project.customer?.name ?? '?'}; ADO: ${project.devops_org}/${project.devops_project})\n\n` +
      (envContext ? `${envContext}\n\n` : '') +
      `=== AÇIK ADO İŞ KALEMLERİ (${adoItems.length}) ===\n${itemLines.join('\n') || '(yok)'}\n\n` +
      `=== TAKİPSİZ MÜŞTERİ KONULARI (${threadLines.length}) ===\n${threadLines.join('\n') || '(yok)'}\n\n` +
      `=== PLATFORM GÖREVLERİ (${openTasks.length}) ===\n${openTasks.map((t) => `${t.title} [${t.priority}]`).join('\n') || '(yok)'}\n\n` +
      `=== SON AKTİVİTELER ===\n${feed.map((a) => `[${a.channel}/${a.status}] ${a.subject ?? ''}`).join('\n') || '(yok)'}`;

    const pmResource = await this.prisma.ai_resources.findFirst({ where: { key: 'ai_delivery_pm', status: 'active' } });
    const req = {
      run_id: `brief-${id.slice(0, 8)}-${Date.now()}`,
      workspace_id: project.workspace_id ?? undefined,
      ai_resource: {
        key: 'ai_project_brief', // non-registered → neutral generic graph
        name: 'AI Project Brief',
        system_prompt:
          'Sen kıdemli bir D365 Business Central teslimat yöneticisisin. Sana bir projenin açık iş kalemleri (#id, tip/durum, başlık, atanan, son değişiklik tarihi) verilecek. ' +
          'draft.content alanına TÜRKÇE, markdown formatında şu dört başlıkla bir yapılacaklar brifi yaz:\n' +
          '## 📋 Proje Yöneticisi\n## 🎯 Lead Danışman\n## 💻 Developer\n## ⚠️ Riskler\n' +
          'KATI KURALLAR:\n' +
          '1) SADECE listede gerçekten geçen #id numaralarını kullan; listede olmayan numara UYDURMA.\n' +
          '2) Her madde şu formatta olsun: "#id ‘başlık’: <somut sonraki adım> (<atanan veya ATANMAMIŞ>, son değişiklik <tarih>)". Başlığı listeden aynen al.\n' +
          '3) "Gözden geçirin", "durumunu kontrol edin", "aksiyonları belirleyin" gibi GENEL ifadeler YASAK — her madde işin başlığından anlaşılan İŞE ÖZGÜ bir adım önersin (örn. geliştirmeyi tamamla, test senaryosu yaz, müşteriden onay iste, UAT’a al, atama yap).\n' +
          '4) Tamamen Türkçe yaz; İngilizce kelime karıştırma.\n' +
          '5) Rol dağılımı: PM → atanmamış/duran işler, önceliklendirme, müşteri iletişimi; Lead Danışman → fonksiyonel tasarım/onay isteyen işler; Developer → DEV: önekli ve Active durumdaki geliştirmeler.\n' +
          '6) Her başlıkta en fazla 5 madde, Riskler’de en fazla 3 madde; en eski (son değişikliği en geride kalan) işlere öncelik ver.\n' +
          'Yanıtı AgentResult JSON şemasında döndür.',
        provider: pmResource?.llm_provider ?? 'nvidia',
        model: pmResource?.llm_model ?? 'meta/llama-3.3-70b-instruct',
        temperature: 0.3,
        tools: [],
        confidence_threshold: 0.5,
      },
      activity: { id: `brief-${Date.now()}`, channel: 'manual', subject: `${project.name} — rol bazlı yapılacaklar`, body, priority: 'normal', customer: null },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
    };
    const res = await fetch(`${process.env.AGENT_URL ?? 'http://localhost:8000'}/v1/agents/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN ?? 'dev-internal-token' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { ok: false, detail: `agent ${res.status}` };
    const data: any = await res.json();
    const content = String(data?.draft?.content ?? '').trim();
    // Never cache a degraded answer: the stub leaves token_usage.provider unset
    // (and the fallback tier flags itself) — surface it instead of saving junk.
    const tu = data?.token_usage ?? {};
    if (!content || !tu.provider || tu.fallback || tu.stub) {
      return { ok: false, detail: `model yanıtı alınamadı (${tu.fallback_from ? 'fallback: ' + (tu.error ?? '') : 'stub'}) — tekrar deneyin` };
    }

    const brief = { generatedAt: new Date().toISOString(), content, model: data?.model ?? null, itemCount: adoItems.length };
    await (this.prisma as any).projects.update({
      where: { id },
      data: { metadata: { ...((project.metadata as any) ?? {}), brief } },
    });
    return { ok: true, brief };
  }

  // The live per-project dashboard payload: status + due-date buckets + feed.
  @Get(':id/dashboard')
  async dashboard(@Param('id') id: string) {
    const project = await (this.prisma as any).projects.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, domain: true } } },
    });
    if (!project) return null;
    const now = new Date();

    const [tasks, dueActivities, missions, threads, pendingApprovals, feed, statusReport] = await Promise.all([
      this.prisma.tasks.findMany({
        where: { project_id: id, status: { in: ['open', 'in_progress'] } },
        select: { id: true, title: true, due_date: true, priority: true, status: true, external_ref: true, assignee_user_id: true, assignee_resource_id: true, mission_id: true },
        orderBy: { due_date: 'asc' },
        take: 300,
      }),
      this.prisma.activities.findMany({
        where: { project_id: id, due_at: { not: null }, status: { notIn: ['completed', 'archived', 'failed'] } },
        select: { id: true, subject: true, due_at: true, channel: true, status: true },
        take: 200,
      }),
      (this.prisma as any).missions.findMany({
        where: { project_id: id, status: { in: ['planning', 'running', 'blocked'] } },
        select: { id: true, title: true, status: true, created_at: true },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
      (this.prisma as any).coverage_threads.findMany({
        where: { project_id: id, state: { in: ['at_risk', 'stalled', 'escalated'] } },
        select: { id: true, subject: true, counterpart: true, state: true, stalled_reason: true, sla_deadline_at: true, channel: true },
        take: 100,
      }).catch(() => []),
      this.prisma.approvals.count({ where: { status: 'pending', activity: { project_id: id } } }),
      this.prisma.activities.findMany({
        where: { project_id: id },
        select: { id: true, subject: true, channel: true, status: true, received_at: true },
        orderBy: { received_at: 'desc' },
        take: 20,
      }),
      project.cosmos_org_name && project.cosmos_project_name
        ? (this.prisma as any).status_reports.findFirst({
            where: { project_label: project.cosmos_project_name },
            orderBy: { created_at: 'desc' },
            select: { id: true, health: true, findings: true, period_label: true, created_at: true },
          })
        : null,
    ]);

    // Live ADO items: ALL open work items of the mapped project (regardless of
    // last-change date) — most items are undated, so they surface in the
    // 'undated' bucket instead of silently vanishing.
    let adoItems: { id: string; title: string; state: string; type: string; due: string | null; assignee?: string; changed?: string }[] = [];
    if (devopsConfigured() && project.devops_org && project.devops_project) {
      try {
        const items = await fetchOpenWorkItems(project.devops_org, String(project.devops_project), 200);
        adoItems = items.map((w) => ({
          id: w.id, title: w.title, state: w.state, type: w.type,
          due: w.dueDate ?? w.targetDate ?? null, assignee: w.assignee, changed: w.changedDate,
        }));
      } catch (e) {
        this.logger.warn(`ADO dashboard fetch failed: ${(e as Error).message}`);
      }
    }

    type Item = { kind: 'task' | 'activity' | 'ado' | 'coverage'; id: string; title: string; due: string | null; ref: string | null; extra?: Record<string, unknown> };
    const items: Item[] = [
      ...tasks.map((t: any): Item => ({ kind: 'task', id: t.id, title: t.title, due: t.due_date?.toISOString() ?? null, ref: t.mission_id ? `/missions/${t.mission_id}` : null, extra: { priority: t.priority, status: t.status } })),
      ...dueActivities.map((a: any): Item => ({ kind: 'activity', id: a.id, title: a.subject ?? '(no subject)', due: a.due_at?.toISOString() ?? null, ref: `/inbox/${a.id}`, extra: { channel: a.channel, status: a.status } })),
      ...adoItems.map((w): Item => ({ kind: 'ado', id: w.id, title: `[#${w.id}] ${w.title}`, due: w.due, ref: project.devops_org ? `https://dev.azure.com/${project.devops_org}/${encodeURIComponent(String(project.devops_project))}/_workitems/edit/${w.id}` : null, extra: { state: w.state, type: w.type, assignee: w.assignee } })),
      ...(threads as any[]).map((t): Item => ({ kind: 'coverage', id: t.id, title: `${t.counterpart ?? '?'} — ${t.subject ?? '(thread)'}`, due: t.sla_deadline_at ? new Date(t.sla_deadline_at).toISOString() : null, ref: null, extra: { state: t.state, reason: t.stalled_reason, channel: t.channel } })),
    ];
    const buckets = bucketByDue(items, (i) => i.due, now) as Record<DueBucket, Item[]>;

    // Cache ADO stats on the row so the portfolio list shows real open counts
    // without hitting ADO per card.
    try {
      await (this.prisma as any).projects.update({
        where: { id },
        data: {
          metadata: {
            ...((project.metadata as any) ?? {}),
            stats: { adoOpen: adoItems.length, adoOverdue: buckets.overdue.length, at: now.toISOString() },
          },
        },
      });
    } catch { /* non-critical */ }

    return {
      project,
      health: project.health ?? statusReport?.health ?? null,
      statusReport,
      brief: ((project.metadata as any) ?? {}).brief ?? null,
      kpis: {
        openItems: items.length,
        overdue: buckets.overdue.length,
        stalledThreads: (threads as any[]).length,
        runningMissions: missions.length,
        pendingApprovals,
      },
      buckets,
      adoByState: adoItems.reduce((acc: Record<string, number>, w) => { acc[w.state] = (acc[w.state] ?? 0) + 1; return acc; }, {}),
      missions,
      feed,
      generatedAt: now.toISOString(),
    };
  }
}

@Module({
  imports: [AuditModule],
  controllers: [ProjectsController, StoryDocsController],
  providers: [ProjectSyncService, CosmosTimelogService],
})
export class ProjectsModule {}
