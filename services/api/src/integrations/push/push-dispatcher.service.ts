import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { fcmConfigured, sendFcm } from './fcm';

const PUSH_TICK_MS = Number(process.env.PUSH_TICK_MS ?? 20000);

// Watermark-scan push dispatcher: every tick, push newly created pending
// approvals and notifications to all registered devices of that workspace.
// Runs even without FCM creds (sendFcm mocks) so the pipeline is verifiable.
@Injectable()
export class PushDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PushDispatcher');
  private timer: NodeJS.Timeout | null = null;
  private approvalsSince = new Date();
  private notificationsSince = new Date();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.ENABLE_PUSH === 'false') {
      this.logger.log('Push dispatcher disabled (ENABLE_PUSH=false).');
      return;
    }
    this.logger.log(`Push dispatcher active (tick ${PUSH_TICK_MS}ms, fcm=${fcmConfigured() ? 'live' : 'mock'}).`);
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.warn(e.message)), PUSH_TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    // 1. New pending approvals since the watermark.
    const approvals = await this.prisma.approvals.findMany({
      where: { status: 'pending', created_at: { gt: this.approvalsSince } },
      include: { activity: true },
      orderBy: { created_at: 'asc' },
      take: 50,
    });
    for (const a of approvals) {
      try {
        await this.pushToWorkspace(
          a.workspace_id,
          { title: `Yeni onay: ${a.action}`, body: (a.activity?.subject ?? a.reason ?? '').slice(0, 160) },
          { type: 'approval', id: a.id },
        );
      } catch (e) {
        this.logger.warn(`push failed for approval ${a.id}: ${(e as Error).message}`);
      }
      // Advance per-row so a mid-batch failure never silently drops the rest.
      this.approvalsSince = a.created_at;
    }

    // 2. New notifications since the watermark.
    const notifs = await (this.prisma as any).notifications.findMany({
      where: { created_at: { gt: this.notificationsSince } },
      orderBy: { created_at: 'asc' },
      take: 50,
    });
    for (const n of notifs) {
      try {
        await this.pushToWorkspace(
          n.workspace_id,
          { title: String(n.title).slice(0, 100), body: String(n.message).slice(0, 160) },
          { type: 'notification', id: n.id },
        );
      } catch (e) {
        this.logger.warn(`push failed for notification ${n.id}: ${(e as Error).message}`);
      }
      this.notificationsSince = n.created_at;
    }
  }

  private async pushToWorkspace(
    wsId: string | null,
    notification: { title: string; body: string },
    data: Record<string, string>,
  ) {
    // Tenant isolation: only devices registered to the event's workspace get
    // the push. Unscoped events (no workspace) are not fanned out at all.
    if (!wsId) return;
    const tokens = await (this.prisma as any).device_tokens.findMany({ where: { workspace_id: wsId } });
    for (const t of tokens) {
      const result = await sendFcm(t.token, notification, data);
      if (result === 'unregistered') {
        await (this.prisma as any).device_tokens.deleteMany({ where: { token: t.token } });
        this.logger.log(`pruned unregistered device token ${String(t.token).slice(0, 12)}…`);
      }
    }
    if (tokens.length) this.logger.log(`push "${notification.title}" → ${tokens.length} device(s)`);
  }
}

@Module({ providers: [PushDispatcherService] })
export class PushDispatcherModule {}
