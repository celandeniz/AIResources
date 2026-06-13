// ADO Ingestion Service — polls Azure DevOps work items (live REST or Cosmos
// fallback) and feeds them into the Activity Inbox as devops-channel activities.
// Mirrors the structure of email-watch.service.ts and ingestion.poller.ts.

import { Injectable, OnModuleInit, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivitiesService } from '../modules/inbox/activities.service';
import { InboxModule } from '../modules/inbox/inbox.module';
import { CosmosTimelogService } from './cosmos/timelog.service';
import { fetchRecentWorkItems, devopsConfigured } from './devops/devops.adapter';
import { tenantStore } from '../common/tenant';

const ENABLE_ADO_INGESTION = process.env.ENABLE_ADO_INGESTION !== 'false';
const ADO_POLL_INTERVAL_MS = Number(process.env.ADO_POLL_INTERVAL_MS ?? 300000);

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
      for (const item of items) {
        const body = [
          `Type: ${item.type} · State: ${item.state} · Assignee: ${item.assignee ?? '—'} · Priority: ${item.priority ?? '—'}`,
          '',
          item.description ?? '',
        ].join('\n').trim();
        try {
          await this.activities.ingest({
            source_id: sourceId,
            channel: 'devops',
            external_id: `ado:${item.id}`,
            from: item.assignee ?? '',
            subject: `[#${item.id}] ${item.title}`,
            body,
          });
        } catch (e) {
          this.logger.warn(`ADO ingest failed for item ${item.id}: ${(e as Error).message}`);
        }
        if (item.changedDate) {
          const ts = new Date(item.changedDate).getTime();
          if (ts > maxChangedAt) maxChangedAt = ts;
        }
      }
      if (items.length) this.logger.log(`ADO ingestion (${org}): ingested ${items.length} work item(s)`);
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

@Module({
  imports: [InboxModule],
  providers: [AdoIngestionService, CosmosTimelogService],
})
export class AdoIngestionModule {}
