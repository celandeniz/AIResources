import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { ExecutorService } from '../../integrations/executor.service';
import { emitStreamEvent } from '../../common/events';
import type { AuthUser } from '../../auth/decorators';

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly executor: ExecutorService,
  ) {}

  list(filters: { status?: string; aiResourceId?: string; riskLevel?: string }) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.riskLevel) where.risk_level = filters.riskLevel;
    return this.prisma.approvals.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        tool_call: true,
        activity: { select: { id: true, subject: true, channel: true, customer_id: true } },
        agent_run: { select: { id: true, ai_resource_id: true, reasoning_summary: true, confidence_score: true } },
      },
    });
  }

  async get(id: string) {
    const a = await this.prisma.approvals.findUnique({
      where: { id },
      include: { tool_call: true, activity: true, agent_run: { include: { ai_resource: { select: { name: true, key: true } } } } },
    });
    if (!a) throw new NotFoundException('approval not found');
    return a;
  }

  async approve(id: string, user: AuthUser, opts: { note?: string; editedPayload?: any }) {
    const approval = await this.prisma.approvals.findUnique({ where: { id }, include: { tool_call: true } });
    if (!approval) throw new NotFoundException('approval not found');
    if (approval.status !== 'pending') throw new ForbiddenException(`approval is ${approval.status}`);

    // Enforce monetary approval limit.
    const amount = approval.amount ? Number(approval.amount) : null;
    if (amount && user.approval_limit !== null && amount > user.approval_limit) {
      throw new ForbiddenException('APPROVAL_LIMIT_EXCEEDED');
    }

    // Optional inline edit of the action payload before executing.
    if (opts.editedPayload && approval.tool_call) {
      await this.prisma.tool_calls.update({ where: { id: approval.tool_call.id }, data: { args: opts.editedPayload } });
    }

    await this.prisma.approvals.update({
      where: { id },
      data: { status: 'approved', reviewer_id: user.id, decided_at: new Date(), decision_notes: opts.note },
    });
    emitStreamEvent({ type: 'approval', workspaceId: approval.workspace_id, payload: { id, status: 'approved' } });
    await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'approve', entityType: 'approvals', entityId: id, activityId: approval.activity_id, summary: `Approved ${approval.action}` });

    let executed: any = null;
    if (approval.tool_call_id) {
      await this.prisma.tool_calls.update({ where: { id: approval.tool_call_id }, data: { status: 'approved' } });
      executed = await this.executor.executeToolCall(approval.tool_call_id, user.id);
    }

    await this.advanceActivity(approval.activity_id);
    return { approval: await this.get(id), executed };
  }

  async reject(id: string, user: AuthUser, note: string) {
    const approval = await this.prisma.approvals.findUnique({ where: { id } });
    if (!approval) throw new NotFoundException('approval not found');
    await this.prisma.approvals.update({ where: { id }, data: { status: 'rejected', reviewer_id: user.id, decided_at: new Date(), decision_notes: note } });
    emitStreamEvent({ type: 'approval', workspaceId: approval.workspace_id, payload: { id, status: 'rejected' } });
    if (approval.tool_call_id) {
      await this.prisma.tool_calls.update({ where: { id: approval.tool_call_id }, data: { status: 'rejected' } });
    }
    await this.prisma.activities.update({ where: { id: approval.activity_id }, data: { status: 'escalated' } });
    await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'reject', entityType: 'approvals', entityId: id, activityId: approval.activity_id, summary: `Rejected ${approval.action}` });
    return this.get(id);
  }

  // When no pending approvals remain for an activity, mark it completed.
  private async advanceActivity(activityId: string) {
    const pending = await this.prisma.approvals.count({ where: { activity_id: activityId, status: 'pending' } });
    if (pending === 0) {
      await this.prisma.activities.update({ where: { id: activityId }, data: { status: 'completed', completed_at: new Date() } });
    }
  }
}
