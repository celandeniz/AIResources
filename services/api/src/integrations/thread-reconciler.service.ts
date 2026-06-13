import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { graphConfigured } from './graph/graph-client';
import { tenantStore } from '../common/tenant';
import { emitStreamEvent } from '../common/events';
import { MESSAGE_ACTIONS } from '../modules/approvals/approvals.service';

// Addresses the OWNER sends from; a reply from any of these (or any team-domain
// address) means a human on our side handled the thread.
const OWNER_EMAILS = (process.env.OWNER_EMAILS ?? process.env.WATCH_OWNER_EMAIL ?? 'deniz@dynamicsops.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const TEAM_DOMAIN = (process.env.WATCH_TEAM_DOMAIN ?? 'dynamicsops.com').toLowerCase();
const ENABLED = process.env.ENABLE_THREAD_RECONCILER !== 'false';
const TICK_MS = Number(process.env.THREAD_RECONCILER_TICK_MS ?? 600000); // 10 min
const GRACE_MS = Number(process.env.THREAD_RECONCILER_GRACE_MS ?? 120000); // 2 min
const MAX_PER_TICK = 50;

export interface ThreadReply {
  from: string;
  at: string;
}

// PURE: is this conversation reply from a human on our side (owner or team),
// not the original customer, and newer than the inbound message? No I/O — unit-testable.
export function isHumanReply(
  reply: ThreadReply,
  ctx: { ownerEmails: string[]; teamDomain: string; originalSender: string; sinceISO: string },
): boolean {
  const from = (reply?.from ?? '').toLowerCase();
  if (!from) return false;
  const isOwner = ctx.ownerEmails.includes(from);
  const isTeam = from.endsWith(`@${ctx.teamDomain}`);
  if (!isOwner && !isTeam) return false;
  if (from === (ctx.originalSender ?? '').toLowerCase()) return false; // never the customer
  return (reply.at ?? '') > ctx.sinceISO;
}

@Injectable()
export class ThreadReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ThreadReconcilerService');
  private readonly email = new GraphEmailAdapter();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!ENABLED) {
      this.logger.log('Thread reconciler disabled (ENABLE_THREAD_RECONCILER=false).');
      return;
    }
    if (!graphConfigured()) {
      this.logger.log('Graph not configured — thread reconciler idle.');
      return;
    }
    this.logger.log(`Thread reconciler active (tick every ${TICK_MS}ms, grace ${GRACE_MS}ms).`);
    this.timer = setInterval(() => this.reconcileOnce().catch((e) => this.logger.error(e.message)), TICK_MS);
    setTimeout(() => this.reconcileOnce().catch((e) => this.logger.error(e.message)), 30000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // One full pass across all live graph_email workspaces.
  async reconcileOnce(): Promise<{ scanned: number; superseded: number }> {
    let scanned = 0;
    let superseded = 0;
    if (!graphConfigured()) return { scanned, superseded };
    const live = await this.prisma.integrations.findMany({ where: { is_mock: false, type: 'graph_email' } });
    for (const row of live) {
      const mailbox = (row.config as any)?.mailbox || (row.config as any)?.external_ref || '';
      if (!mailbox) continue;
      const conn = { id: row.id, type: row.type, name: row.name, config: (row.config as any) ?? {}, isMock: row.is_mock };
      try {
        await tenantStore.run({ workspaceId: row.workspace_id ?? undefined }, async () => {
          const r = await this.processWorkspace(row.workspace_id ?? undefined, conn, mailbox);
          scanned += r.scanned;
          superseded += r.superseded;
        });
      } catch (e) {
        this.logger.warn(`reconcile tick failed for ${row.name}: ${(e as Error).message}`);
      }
    }
    return { scanned, superseded };
  }

  private async processWorkspace(wsId: string | undefined, conn: any, mailbox: string) {
    const graceThreshold = new Date(Date.now() - GRACE_MS);
    const candidates = await this.prisma.approvals.findMany({
      where: {
        status: 'pending',
        action: { in: MESSAGE_ACTIONS as any },
        created_at: { lt: graceThreshold },
        workspace_id: wsId,
      },
      orderBy: { created_at: 'asc' },
      take: MAX_PER_TICK,
      include: {
        activity: { select: { id: true, subject: true, channel: true, metadata: true, received_at: true, created_at: true } },
      },
    });
    let scanned = 0;
    let superseded = 0;
    const seenActivities = new Set<string>();
    for (const ap of candidates) {
      const act = ap.activity as any;
      if (!act || act.channel !== 'email') continue;
      if (seenActivities.has(act.id)) continue; // one supersede per activity per tick
      const conversationId = (act.metadata as any)?.conversation_id ?? null;
      if (!conversationId) continue;
      seenActivities.add(act.id);
      scanned++;
      const did = await this.reconcileActivity(act, conn, mailbox, conversationId, wsId);
      if (did) superseded++;
    }
    return { scanned, superseded };
  }

  // Check one activity's thread; if a human replied, supersede its reply-drafts.
  // Returns true if it superseded. Fail-safe: Graph errors return false (leave pending).
  private async reconcileActivity(
    act: any,
    conn: any,
    mailbox: string,
    conversationId: string,
    wsId: string | undefined,
  ): Promise<boolean> {
    const originalSender = String((act.metadata as any)?.from ?? '').toLowerCase();
    const sinceISO = (act.received_at ?? act.created_at).toISOString();
    let replies: ThreadReply[] = [];
    try {
      replies = await this.email.fetchConversationReplies(conn, mailbox, conversationId, sinceISO);
    } catch (e) {
      this.logger.warn(`reconcile: fetchConversationReplies failed for activity ${act.id}: ${(e as Error).message}`);
      return false; // fail-safe: leave the draft pending
    }
    const human = replies.find((r) =>
      isHumanReply(r, { ownerEmails: OWNER_EMAILS, teamDomain: TEAM_DOMAIN, originalSender, sinceISO }),
    );
    if (!human) return false;
    return this.supersedeActivity(act, human, wsId);
  }

  // Cancel pending reply-message approvals for the activity; preserve internal
  // actions; advance the activity; audit + notify + stream. Idempotent.
  private async supersedeActivity(act: any, human: ThreadReply, wsId: string | undefined): Promise<boolean> {
    const pendingMsgApprovals = await this.prisma.approvals.findMany({
      where: { activity_id: act.id, status: 'pending', action: { in: MESSAGE_ACTIONS as any } },
      include: { tool_call: { select: { id: true } } },
    });
    if (!pendingMsgApprovals.length) return false;
    const note = `Superseded: ${human.from} replied in thread (${human.at})`;
    for (const ap of pendingMsgApprovals) {
      await this.prisma.approvals.update({
        where: { id: ap.id },
        data: { status: 'cancelled', decided_at: new Date(), reviewer_id: null, decision_notes: note },
      });
      if ((ap as any).tool_call?.id) {
        // 'skipped' = not executed (a human handled the thread). 'cancelled' is
        // not a valid tool_call_status enum value.
        await this.prisma.tool_calls.update({ where: { id: (ap as any).tool_call.id }, data: { status: 'skipped' } });
      }
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: wsId,
          actor_type: 'system',
          action: 'route',
          entity_type: 'approvals',
          entity_id: ap.id,
          activity_id: act.id,
          summary: note,
        },
      });
      emitStreamEvent({ type: 'approval', workspaceId: wsId, payload: { id: ap.id, status: 'cancelled' } });
    }
    const remaining = await this.prisma.approvals.count({ where: { activity_id: act.id, status: 'pending' } });
    const meta = (act.metadata as any) ?? {};
    await this.prisma.activities.update({
      where: { id: act.id },
      data: {
        ...(remaining === 0 ? { status: 'completed', completed_at: new Date() } : {}),
        metadata: { ...meta, superseded_by_human: { by: human.from, at: human.at } },
      },
    });
    await (this.prisma as any).notifications.create({
      data: {
        workspace_id: wsId,
        type: 'draft_superseded',
        title: 'AI taslağı iptal edildi',
        message: `'${act.subject ?? '(konusuz)'}' thread'ine ${human.from} yanıt verdi — bekleyen AI taslağı iptal edildi.`,
        metadata: { activityId: act.id },
      },
    });
    this.logger.log(`reconcile: superseded ${pendingMsgApprovals.length} draft(s) for activity ${act.id} (human: ${human.from})`);
    return true;
  }
}
