// ADO Ingestion Service — polls Azure DevOps work items (live REST or Cosmos
// fallback) and feeds them into the Activity Inbox as devops-channel activities.
// Mirrors the structure of email-watch.service.ts and ingestion.poller.ts.

import { Injectable, OnModuleInit, Logger, Module, Controller, Post, Body, Query, UnauthorizedException } from '@nestjs/common';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ActivitiesService } from '../modules/inbox/activities.service';
import { InboxModule } from '../modules/inbox/inbox.module';
import { CosmosTimelogService } from './cosmos/timelog.service';
import { fetchRecentWorkItems, fetchWorkItemComments, devopsConfigured, adoSelfIdentity, isSelfAuthored } from './devops/devops.adapter';
import { tenantStore } from '../common/tenant';

const ENABLE_ADO_INGESTION = process.env.ENABLE_ADO_INGESTION !== 'false';
const ADO_POLL_INTERVAL_MS = Number(process.env.ADO_POLL_INTERVAL_MS ?? 300000);
// Revision-aware re-ingestion: with this ON, updates to a work item re-ingest
// as `ado:{id}:r{rev}` (the (source_id, external_id) dedupe otherwise drops
// every update forever). Requires echo suppression (self-identity skip) —
// without a resolvable self identity we fail CLOSED back to id-only ingestion.
const ENABLE_ADO_UPDATE_REINGEST = process.env.ENABLE_ADO_UPDATE_REINGEST === 'true';

// DEFAULT workspace — used for Cosmos-only ingestion when no live ado_org integration exists.
const DEFAULT_WS_ID = '00000000-0000-0000-0000-0000000000ff';

@Injectable()
export class AdoIngestionService implements OnModuleInit {
  private readonly logger = new Logger('AdoIngestionService');
  // In-memory watermark map for workspaces that have no live ado_org integration row.
  private readonly cosmosWatermark = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly cosmos: CosmosTimelogService,
  ) {}

  onModuleInit() {
    if (!ENABLE_ADO_INGESTION) {
      this.logger.log('ADO ingestion disabled (ENABLE_ADO_INGESTION=false).');
      return;
    }
    this.logger.log(`ADO ingestion active (interval ${ADO_POLL_INTERVAL_MS}ms).`);
    setInterval(() => this.tick().catch((e: Error) => this.logger.error(e.message)), ADO_POLL_INTERVAL_MS);
    // Run once shortly after boot
    setTimeout(() => this.tick().catch((e: Error) => this.logger.error(e.message)), 20000);
  }

  async tick() {
    // Find live ado_org integrations (is_mock=false).
    const liveRows = await this.prisma.integrations.findMany({
      where: { is_mock: false, type: 'ado_org' },
    });

    if (liveRows.length > 0) {
      for (const row of liveRows) {
        try {
          await tenantStore.run({ workspaceId: row.workspace_id ?? undefined }, async () => {
            await this.processOrg(row, row.workspace_id ?? DEFAULT_WS_ID);
          });
        } catch (e) {
          this.logger.warn(`ADO ingestion tick failed for integration ${row.name}: ${(e as Error).message}`);
        }
      }
    } else {
      // No live ado_org integrations — run Cosmos-sourced ingestion under the default workspace.
      await tenantStore.run({ workspaceId: DEFAULT_WS_ID }, async () => {
        await this.processOrg(null, DEFAULT_WS_ID);
      });
    }
  }

  private async processOrg(integrationRow: any | null, wsId: string) {
    // Determine sinceMs from watermark.
    let sinceMs: number | undefined;

    if (integrationRow) {
      const config = (integrationRow.config as any) ?? {};
      if (config.ado_since) {
        sinceMs = new Date(config.ado_since as string).getTime();
      }
    } else {
      // In-memory watermark for default-workspace Cosmos ingestion.
      sinceMs = this.cosmosWatermark.get(wsId);
    }

    // Baseline: first-ever run — set watermark to now and skip backlog.
    if (sinceMs === undefined) {
      const now = Date.now();
      await this.persistWatermark(integrationRow, wsId, now);
      this.logger.log(`ADO ingestion baselined for ${integrationRow?.name ?? 'Cosmos/default'} — backlog skipped`);
      return;
    }

    const sinceISO = new Date(sinceMs).toISOString();
    let maxChangedAt = sinceMs;

    if (devopsConfigured() && integrationRow?.config?.org) {
      // Live ADO REST path
      const org = integrationRow.config.org as string;
      const sourceId = await this.ensureSource(integrationRow.id, integrationRow.name, 'devops');
      const items = await fetchRecentWorkItems(org, sinceISO, 25);
      // Echo suppression: skip changes the platform itself made. Rev re-ingestion
      // is only enabled when the self identity resolves (fail closed).
      const self = await adoSelfIdentity(org);
      const revAware = ENABLE_ADO_UPDATE_REINGEST && self !== null;
      if (ENABLE_ADO_UPDATE_REINGEST && self === null) {
        this.logger.warn('ADO update re-ingestion requested but self identity unresolved (set ADO_SELF_IDENTITY) — falling back to id-only ingestion.');
      }
      let skippedSelf = 0;
      for (const item of items) {
        if (isSelfAuthored(item.changedBy, self)) {
          skippedSelf++;
          if (item.changedDate) {
            const ts = new Date(item.changedDate).getTime();
            if (ts > maxChangedAt) maxChangedAt = ts;
          }
          continue;
        }
        // Seed recent (non-self) ticket discussion into the activity body so
        // missions start with full context. Best-effort.
        let commentBlock = '';
        try {
          const comments = await fetchWorkItemComments(org, item.id, 10, { filterSelf: true });
          if (comments.length) {
            commentBlock = '\n\n--- Recent comments ---\n' + comments
              .map((c) => `• ${c.by ?? '?'}${c.at ? ` (${c.at.slice(0, 10)})` : ''}: ${c.text.slice(0, 400)}`)
              .join('\n');
          }
        } catch { /* comments are optional context */ }
        const body = [
          `Type: ${item.type} · State: ${item.state} · Assignee: ${item.assignee ?? '—'} · Priority: ${item.priority ?? '—'}`,
          '',
          (item.description ?? '') + commentBlock,
        ].join('\n').trim();
        try {
          await this.activities.ingest({
            source_id: sourceId,
            channel: 'devops',
            external_id: revAware ? `ado:${item.id}:r${item.rev ?? 0}` : `ado:${item.id}`,
            from: item.assignee ?? '',
            subject: `[#${item.id}] ${item.title}`,
            body,
            metadata: {
              ado: {
                id: item.id,
                org,
                project: item.project ?? null,
                rev: item.rev ?? null,
                type: item.type,
                state: item.state,
                tags: item.tags ?? [],
                iterationPath: item.iterationPath ?? null,
                areaPath: item.areaPath ?? null,
                changedBy: item.changedBy ?? null,
                targetDate: item.targetDate ?? null,
                dueDate: item.dueDate ?? null,
              },
            },
          });
        } catch (e) {
          this.logger.warn(`ADO ingest failed for item ${item.id}: ${(e as Error).message}`);
        }
        if (item.changedDate) {
          const ts = new Date(item.changedDate).getTime();
          if (ts > maxChangedAt) maxChangedAt = ts;
        }
      }
      if (items.length) this.logger.log(`ADO ingestion (${org}): ingested ${items.length - skippedSelf}/${items.length} work item(s)${skippedSelf ? ` (${skippedSelf} self-authored skipped)` : ''}`);
    } else {
      // Cosmos fallback path
      const sourceId = await this.ensureSource(null, 'Azure DevOps (Cosmos)', 'devops');
      const tasks = await this.cosmos.fetchTasksChangedSince({ sinceMs, cap: 25 });
      for (const task of tasks) {
        const body = [
          `Type: ${task.type ?? task.workItemType ?? '—'} · State: ${task.state ?? '—'} · Assignee: ${task.assignee ?? '—'} · Priority: ${task.priority ?? '—'}`,
          '',
          '',
        ].join('\n').trim();
        try {
          await this.activities.ingest({
            source_id: sourceId,
            channel: 'devops',
            external_id: `ado:${task.workItemId}`,
            from: task.assignee ?? '',
            subject: `[#${task.workItemId}] ${task.title}`,
            body,
          });
        } catch (e) {
          this.logger.warn(`ADO Cosmos ingest failed for task ${task.workItemId}: ${(e as Error).message}`);
        }
        const changedAt = task.changedAt ?? task.updatedAt ?? task.createdAt;
        if (changedAt) {
          const ts = new Date(changedAt).getTime();
          if (ts > maxChangedAt) maxChangedAt = ts;
        }
      }
      if (tasks.length) this.logger.log(`ADO ingestion (Cosmos): ingested ${tasks.length} task(s)`);
    }

    // Advance watermark
    await this.persistWatermark(integrationRow, wsId, maxChangedAt);
  }

  private async persistWatermark(integrationRow: any | null, wsId: string, ts: number) {
    if (integrationRow) {
      try {
        await this.prisma.integrations.update({
          where: { id: integrationRow.id },
          data: { config: { ...(integrationRow.config as any), ado_since: new Date(ts).toISOString() } },
        });
      } catch { /* non-critical */ }
    } else {
      this.cosmosWatermark.set(wsId, ts);
    }
  }

  // Find or create an activity_sources row for this integration / channel.
  // When integrationId is null (Cosmos fallback), find/create by name.
  private async ensureSource(integrationId: string | null, name: string, channel: any): Promise<string> {
    if (integrationId) {
      const existing = await this.prisma.activity_sources.findFirst({ where: { integration_id: integrationId } });
      if (existing) return existing.id;
      const created = await this.prisma.activity_sources.create({
        data: { name: `${name} (live)`, channel, integration_id: integrationId },
      });
      return created.id;
    }
    // No integration row — find/create by name for the Cosmos default source.
    const existing = await this.prisma.activity_sources.findFirst({ where: { name } });
    if (existing) return existing.id;
    const created = await this.prisma.activity_sources.create({
      data: { name, channel },
    });
    return created.id;
  }
}

// ── ADO Service Hook receiver (push trigger; the 5-min poll stays as fallback).
// Configure two Service Hooks per ADO project (workitem.created + .updated)
// pointing at POST /api/v1/integrations/ado/webhook?token=<ADO_WEBHOOK_SECRET>.
// Idempotent with the poller via the shared (source_id, external_id) dedupe.
@Controller('integrations/ado')
export class AdoWebhookController {
  private readonly logger = new Logger('AdoWebhook');
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  @Public()
  @Post('webhook')
  async webhook(@Query('token') token: string, @Body() body: any) {
    const secret = process.env.ADO_WEBHOOK_SECRET;
    if (!secret || token !== secret) throw new UnauthorizedException('bad webhook token'); // fail-closed
    const res = body?.resource ?? {};
    const fields = res.fields ?? res.revision?.fields ?? {};
    const id = String(res.workItemId ?? res.id ?? '');
    if (!id) return { ok: false, detail: 'no work item id' };
    const rev = Number(res.rev ?? res.revision?.rev ?? 0);
    const changedByRaw = fields['System.ChangedBy'];
    const changedBy = typeof changedByRaw === 'object' ? changedByRaw?.displayName : changedByRaw;
    // Echo suppression — same rule as the poller.
    const orgUrl: string = body?.resourceContainers?.collection?.baseUrl ?? '';
    const org = orgUrl.match(/dev\.azure\.com\/([^/]+)/)?.[1] ?? (process.env.ADO_ORGS ?? '').split(',')[0]?.trim() ?? '';
    const self = await adoSelfIdentity(org);
    if (isSelfAuthored(typeof changedBy === 'string' ? changedBy : undefined, self)) {
      return { ok: true, skipped: 'self-authored' };
    }
    const revAware = ENABLE_ADO_UPDATE_REINGEST && self !== null;
    const row = await this.prisma.integrations.findFirst({ where: { is_mock: false, type: 'ado_org' } });
    return tenantStore.run({ workspaceId: row?.workspace_id ?? DEFAULT_WS_ID }, async () => {
      const source = await this.prisma.activity_sources.findFirst({
        where: row ? { integration_id: row.id } : { name: 'Azure DevOps (Cosmos)' },
      });
      const title = fields['System.Title'] ?? `Work item ${id}`;
      const result = await this.activities.ingest({
        source_id: source?.id,
        channel: 'devops',
        external_id: revAware ? `ado:${id}:r${rev}` : `ado:${id}`,
        from: (typeof fields['System.AssignedTo'] === 'object' ? fields['System.AssignedTo']?.displayName : fields['System.AssignedTo']) ?? '',
        subject: `[#${id}] ${title}`,
        body: String(fields['System.Description'] ?? '').replace(/<[^>]+>/g, '').slice(0, 2000),
        metadata: {
          ado: {
            id, org, rev,
            project: fields['System.TeamProject'] ?? null,
            type: fields['System.WorkItemType'] ?? null,
            state: fields['System.State'] ?? null,
            tags: typeof fields['System.Tags'] === 'string' ? fields['System.Tags'].split(';').map((t: string) => t.trim()).filter(Boolean) : [],
            iterationPath: fields['System.IterationPath'] ?? null,
            areaPath: fields['System.AreaPath'] ?? null,
            changedBy: changedBy ?? null,
            via: 'webhook',
          },
        },
      });
      this.logger.log(`ADO webhook ingested #${id} r${rev}`);
      return result;
    });
  }
}

@Module({
  imports: [InboxModule],
  providers: [AdoIngestionService, CosmosTimelogService],
  controllers: [AdoWebhookController],
})
export class AdoIngestionModule {}
