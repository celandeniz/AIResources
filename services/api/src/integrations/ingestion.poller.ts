import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActivitiesService } from '../modules/inbox/activities.service';
import { InboxModule } from '../modules/inbox/inbox.module';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { GraphTeamsAdapter } from './graph/graph-teams.adapter';
import { graphConfigured } from './graph/graph-client';
import { tenantStore } from '../common/tenant';
import type { ConnectionInfo } from './contracts';

// Polls live (is_mock=false) Microsoft Graph connections for new mail / Teams
// messages and feeds them into the Activity Inbox (dedup + enqueue via ingest).
@Injectable()
export class IngestionPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('IngestionPoller');
  private readonly email = new GraphEmailAdapter();
  private readonly teams = new GraphTeamsAdapter();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60000);
    if (!graphConfigured()) {
      this.logger.log('Graph not configured — ingestion poller idle (set GRAPH_* to enable).');
      return;
    }
    this.logger.log(`Ingestion poller active (every ${intervalMs}ms).`);
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(e.message)), intervalMs);
    // also run once shortly after boot
    setTimeout(() => this.tick().catch((e) => this.logger.error(e.message)), 5000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async ensureSource(integrationId: string, name: string, channel: any): Promise<string> {
    const existing = await this.prisma.activity_sources.findFirst({ where: { integration_id: integrationId } });
    if (existing) return existing.id;
    const created = await this.prisma.activity_sources.create({
      data: { name: `${name} (live)`, channel, integration_id: integrationId },
    });
    return created.id;
  }

  private toConn(row: any): ConnectionInfo {
    return { id: row.id, type: row.type, name: row.name, config: (row.config as any) ?? {}, isMock: row.is_mock };
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const live = await this.prisma.integrations.findMany({
        where: { is_mock: false, type: { in: ['graph_email', 'graph_teams'] } },
      });
      for (const row of live) {
        try {
          // Run each connection's ingestion inside its workspace context so the
          // Prisma tenant-guard stamps activities/sources with workspace_id.
          await tenantStore.run({ workspaceId: row.workspace_id ?? undefined }, async () => {
            if (row.type === 'graph_email') await this.pollEmail(row);
            else if (row.type === 'graph_teams') await this.pollTeams(row);
          });
        } catch (e) {
          await this.prisma.integrations.update({ where: { id: row.id }, data: { last_error: (e as Error).message, status: 'error' } });
          this.logger.warn(`poll ${row.name} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollEmail(row: any) {
    const conn = this.toConn(row);
    const sourceId = await this.ensureSource(row.id, row.name, 'email');
    const { messages, watermark, baseline } = await this.email.pollNewMessages(conn);
    const capped = messages.slice(0, 25); // defense-in-depth against bursts
    for (const m of capped) {
      await this.activities.ingest({
        source_id: sourceId,
        channel: 'email',
        external_id: m.internetMessageId || m.id,
        from: m.from,
        subject: m.subject,
        body: m.bodyPreview,
        to: m.to,
        cc: m.cc,
        conversation_id: m.conversationId,
        headers: m.headers,
      });
    }
    await this.prisma.integrations.update({
      where: { id: row.id },
      data: { config: { ...(row.config as any), mail_since: watermark }, status: 'connected', last_synced_at: new Date(), last_error: null },
    });
    if (baseline) this.logger.log(`Outlook ${conn.config.mailbox}: baselined at ${watermark} (backlog skipped)`);
    else if (capped.length) this.logger.log(`Outlook ${conn.config.mailbox}: ingested ${capped.length} new message(s)`);
  }

  private async pollTeams(row: any) {
    const conn = this.toConn(row);
    const sourceId = await this.ensureSource(row.id, row.name, 'teams');
    const { messages, since } = await this.teams.pollChannelMessages(conn);
    for (const m of messages) {
      await this.activities.ingest({
        source_id: sourceId,
        channel: 'teams',
        external_id: m.id,
        from: m.from,
        subject: m.text.slice(0, 80),
        body: m.text,
      });
    }
    await this.prisma.integrations.update({
      where: { id: row.id },
      data: { config: { ...(row.config as any), last_sync: since }, status: 'connected', last_synced_at: new Date(), last_error: null },
    });
    if (messages.length) this.logger.log(`Teams channel: ingested ${messages.length} new message(s)`);
  }
}

@Module({
  imports: [InboxModule],
  providers: [IngestionPoller],
})
export class IngestionModule {}
