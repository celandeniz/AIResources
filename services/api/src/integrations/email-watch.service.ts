import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InboxModule } from '../modules/inbox/inbox.module';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { graphConfigured } from './graph/graph-client';
import { tenantStore } from '../common/tenant';

const WATCH_OWNER_EMAIL = (process.env.WATCH_OWNER_EMAIL ?? 'deniz@dynamicsops.com').toLowerCase();
const WATCH_TEAM_DOMAIN = (process.env.WATCH_TEAM_DOMAIN ?? 'dynamicsops.com').toLowerCase();
const EMAIL_WATCH_SLA_HOURS = Number(process.env.EMAIL_WATCH_SLA_HOURS ?? 48);
const EMAIL_WATCH_TICK_MS = Number(process.env.EMAIL_WATCH_TICK_MS ?? 1800000);

@Injectable()
export class EmailWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('EmailWatchService');
  private readonly email = new GraphEmailAdapter();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.EMAIL_WATCH_ENABLED === 'false') {
      this.logger.log('Email watch disabled (EMAIL_WATCH_ENABLED=false).');
      return;
    }
    if (!graphConfigured()) {
      this.logger.log('Graph not configured — email-watch service idle (set GRAPH_* to enable).');
      return;
    }
    this.logger.log(`Email-watch service active (SLA ${EMAIL_WATCH_SLA_HOURS}h, tick every ${EMAIL_WATCH_TICK_MS}ms).`);
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(e.message)), EMAIL_WATCH_TICK_MS);
    // Run once shortly after boot
    setTimeout(() => this.tick().catch((e) => this.logger.error(e.message)), 25000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    // Find all active workspaces (integrations that have graph_email)
    const liveIntegrations = await this.prisma.integrations.findMany({
      where: { is_mock: false, type: 'graph_email' },
    });

    const slaMs = EMAIL_WATCH_SLA_HOURS * 60 * 60 * 1000;
    const slaThreshold = new Date(Date.now() - slaMs);

    for (const row of liveIntegrations) {
      try {
        await tenantStore.run({ workspaceId: row.workspace_id ?? undefined }, async () => {
          await this.processWorkspace(row, slaThreshold);
        });
      } catch (e) {
        this.logger.warn(`email-watch tick failed for integration ${row.name}: ${(e as Error).message}`);
      }
    }
  }

  private async processWorkspace(integrationRow: any, slaThreshold: Date) {
    const mailbox: string = (integrationRow.config?.mailbox as string) || (integrationRow.config?.external_ref as string) || '';
    if (!mailbox) return;

    // Find overdue watched activities in this workspace
    const watched = await this.prisma.activities.findMany({
      where: {
        status: 'watching',
        workspace_id: integrationRow.workspace_id ?? undefined,
        received_at: { lt: slaThreshold },
      },
    });

    if (!watched.length) return;

    this.logger.log(`email-watch: ${watched.length} overdue watched activity(s) in workspace ${integrationRow.workspace_id ?? 'default'}`);

    // Look up owner user once per workspace
    const ownerUser = await this.prisma.users.findFirst({ where: { email: WATCH_OWNER_EMAIL } });

    const conn = { id: integrationRow.id, type: integrationRow.type, name: integrationRow.name, config: (integrationRow.config as any) ?? {}, isMock: integrationRow.is_mock };

    for (const activity of watched) {
      try {
        await this.processWatchedActivity(activity, conn, mailbox, ownerUser);
      } catch (e) {
        this.logger.warn(`email-watch: failed to process activity ${activity.id}: ${(e as Error).message}`);
      }
    }
  }

  private async processWatchedActivity(activity: any, conn: any, mailbox: string, ownerUser: any) {
    const meta = (activity.metadata as any) ?? {};
    const conversationId: string | null = meta.conversation_id ?? null;
    const receivedIso: string = activity.received_at?.toISOString() ?? new Date(0).toISOString();
    const wsId = activity.workspace_id;
    const subject = activity.subject ?? '(no subject)';
    const fromAddress: string = meta.from ?? 'unknown sender';

    let teamReplied = false;

    if (conversationId) {
      try {
        const replies = await this.email.fetchConversationReplies(conn, mailbox, conversationId, receivedIso);
        teamReplied = replies.some(
          (r) =>
            r.from.endsWith(`@${WATCH_TEAM_DOMAIN}`) &&
            r.from !== fromAddress.toLowerCase() &&
            r.at > receivedIso,
        );
      } catch (e) {
        this.logger.warn(`email-watch: fetchConversationReplies failed for activity ${activity.id}: ${(e as Error).message}`);
        // Fall through to escalation — cannot confirm team reply
      }
    }
    // If no conversationId, fall through to escalation (can't confirm a reply)

    if (teamReplied) {
      await this.prisma.activities.update({
        where: { id: activity.id },
        data: { status: 'completed', completed_at: new Date(), metadata: { ...meta, watch: { ...(meta.watch ?? {}), closed_at: new Date().toISOString(), reason: 'team_replied' } } },
      });
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: wsId,
          actor_type: 'system',
          action: 'route',
          entity_type: 'activities',
          entity_id: activity.id,
          activity_id: activity.id,
          summary: 'Team replied within watch window — closed',
        },
      });
      this.logger.log(`email-watch: activity ${activity.id} closed — team replied`);
    } else {
      // Escalate — no team reply within SLA
      const ageHours = Math.round((Date.now() - new Date(receivedIso).getTime()) / 3600000);
      const taskTitle = `Open item: no reply to "${subject}"`;
      const taskDesc = `Email from ${fromAddress} with subject "${subject}" received ${ageHours}h ago has had no team reply. Please follow up.`;

      await this.prisma.tasks.create({
        data: {
          workspace_id: wsId,
          activity_id: activity.id,
          title: taskTitle,
          description: taskDesc,
          status: 'open',
          priority: 'high',
          assignee_user_id: ownerUser?.id ?? null,
          metadata: { source: 'email-watch', activity_id: activity.id },
        },
      });

      await (this.prisma as any).notifications.create({
        data: {
          workspace_id: wsId,
          type: 'email_watch_escalation',
          title: 'Open item needs your attention',
          message: `No team reply to "${subject}" from ${fromAddress} after ${ageHours}h.`,
          metadata: { activityId: activity.id },
        },
      });

      await this.prisma.activities.update({
        where: { id: activity.id },
        data: {
          status: 'escalated',
          requires_approval: false,
          metadata: { ...meta, watch: { ...(meta.watch ?? {}), escalated_at: new Date().toISOString(), reason: 'no_team_reply' } },
        },
      });

      await this.prisma.audit_logs.create({
        data: {
          workspace_id: wsId,
          actor_type: 'system',
          action: 'escalate',
          entity_type: 'activities',
          entity_id: activity.id,
          activity_id: activity.id,
          summary: `Escalated to owner — no team reply within SLA (${EMAIL_WATCH_SLA_HOURS}h)`,
        },
      });

      this.logger.log(`email-watch: activity ${activity.id} escalated — no team reply after ${ageHours}h`);
    }
  }
}

@Module({
  imports: [InboxModule],
  providers: [EmailWatchService],
})
export class EmailWatchModule {}
