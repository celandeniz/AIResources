import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { AuditService } from '../../common/audit.service';
import { emitStreamEvent } from '../../common/events';
import type { ActivityChannel, Priority } from '@dynops/shared';

export interface ListFilters {
  status?: string;
  channel?: string;
  customerId?: string;
  projectId?: string;
  assignedResourceId?: string;
  priority?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async list(f: ListFilters) {
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(100, f.pageSize ?? 25);
    const where: any = {};
    if (f.status) where.status = f.status;
    if (f.channel) where.channel = f.channel;
    if (f.customerId) where.customer_id = f.customerId;
    if (f.projectId) where.project_id = f.projectId;
    if (f.assignedResourceId) where.assigned_resource_id = f.assignedResourceId;
    if (f.priority) where.priority = f.priority;
    if (f.q) where.OR = [{ subject: { contains: f.q, mode: 'insensitive' } }, { body: { contains: f.q, mode: 'insensitive' } }];

    const [data, total] = await Promise.all([
      this.prisma.activities.findMany({
        where,
        orderBy: { received_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { assigned_resource: { select: { key: true, name: true } }, customer: { select: { name: true } }, project: { select: { name: true } } },
      }),
      this.prisma.activities.count({ where }),
    ]);
    return { data, total, page, pageSize };
  }

  async get(id: string) {
    const a = await this.prisma.activities.findUnique({
      where: { id },
      include: {
        assigned_resource: true,
        customer: true,
        project: true,
        source: true,
        messages: { orderBy: { created_at: 'asc' } },
        documents: true,
        tasks: true,
        approvals: { orderBy: { created_at: 'desc' }, include: { tool_call: true } },
        agent_runs: { orderBy: { created_at: 'desc' }, include: { tool_calls: true } },
      },
    });
    if (!a) throw new NotFoundException('activity not found');
    return a;
  }

  async createManual(input: { subject: string; body?: string; channel?: ActivityChannel; customerId?: string; projectId?: string; priority?: Priority; category?: string }, userId: string) {
    const activity = await this.prisma.activities.create({
      data: {
        channel: input.channel ?? 'manual',
        subject: input.subject,
        body: input.body,
        category: input.category,
        priority: input.priority ?? 'normal',
        customer_id: input.customerId,
        project_id: input.projectId,
        status: 'new',
        metadata: { created_by: userId },
      },
    });
    await this.audit.log({ actorType: 'user', actorUserId: userId, action: 'create', entityType: 'activities', entityId: activity.id, activityId: activity.id, summary: `Manual activity: ${input.subject}` });
    emitStreamEvent({ type: 'activity', workspaceId: activity.workspace_id, payload: activity });
    await this.queue.enqueueActivity(activity.id);
    return activity;
  }

  // Generic ingestion (mock email/Teams/OpsConnect/DevOps/GitHub/BC). Idempotent by (source_id, external_id).
  async ingest(input: { source_id?: string; channel: ActivityChannel; external_id?: string; from?: string; subject?: string; body?: string; customer_id?: string; project_id?: string; category?: string }) {
    if (input.source_id && input.external_id) {
      const existing = await this.prisma.activities.findFirst({ where: { source_id: input.source_id, external_id: input.external_id } });
      if (existing) return { activityId: existing.id, deduped: true };
    }
    // auto-match customer by sender domain
    let customerId = input.customer_id;
    if (!customerId && input.from?.includes('@')) {
      const domain = input.from.split('@')[1];
      const c = await this.prisma.customers.findFirst({ where: { domain } });
      customerId = c?.id;
    }
    const activity = await this.prisma.activities.create({
      data: {
        source_id: input.source_id,
        channel: input.channel,
        external_id: input.external_id,
        subject: input.subject,
        body: input.body,
        category: input.category,
        customer_id: customerId,
        project_id: input.project_id,
        status: 'new',
        metadata: { from: input.from },
      },
    });
    if (input.from || input.body) {
      await this.prisma.messages.create({
        data: { activity_id: activity.id, direction: 'inbound', channel: input.channel, author_type: 'external', from_address: input.from, subject: input.subject, body: input.body },
      });
    }
    await this.audit.log({ actorType: 'system', action: 'ingest', entityType: 'activities', entityId: activity.id, activityId: activity.id, summary: `Ingested from ${input.channel}` });
    emitStreamEvent({ type: 'activity', workspaceId: activity.workspace_id, payload: activity });
    const jobId = await this.queue.enqueueActivity(activity.id);
    return { activityId: activity.id, jobId };
  }

  // Smoke-test helper: synthesizes a realistic inbound customer email.
  async triggerMockEmail() {
    return this.ingest({
      source_id: '00000000-0000-0000-0000-0000000000a1',
      channel: 'email',
      external_id: `mock-${Date.now()}`,
      from: 'dana@contoso.com',
      subject: 'Re: Thursday status call',
      body: 'Hi, can we move Thursday’s status call to Friday afternoon? Friday after 2pm works best for us. Thanks, Dana',
      category: 'scheduling',
    });
  }

  async reprocess(id: string) {
    await this.get(id);
    const jobId = await this.queue.enqueueActivity(id);
    return { jobId };
  }

  async assign(id: string, aiResourceId: string, userId: string) {
    const a = await this.prisma.activities.update({ where: { id }, data: { assigned_resource_id: aiResourceId } });
    await this.audit.log({ actorType: 'user', actorUserId: userId, action: 'route', entityType: 'activities', entityId: id, activityId: id, summary: 'Manual assignment' });
    emitStreamEvent({ type: 'activity', workspaceId: a.workspace_id, payload: a });
    await this.queue.enqueueActivity(id);
    return a;
  }

  async patch(id: string, data: any) {
    const a = await this.prisma.activities.update({ where: { id }, data });
    emitStreamEvent({ type: 'activity', workspaceId: a.workspace_id, payload: a });
    return a;
  }
}
