import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../common/audit.service';
import { getAdapter } from './mock-adapters';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { GraphTeamsAdapter } from './graph/graph-teams.adapter';
import { graphConfigured } from './graph/graph-client';
import { TOOL_REGISTRY, isKnownTool, IntegrationKind, ToolName } from '@dynops/shared';
import { tenantStore } from '../common/tenant';
import type { ConnectorAdapter, ConnectionInfo } from './contracts';

const graphEmail = new GraphEmailAdapter();
const graphTeams = new GraphTeamsAdapter();

// Real adapter when the connection is live (is_mock=false) and Graph is configured; else mock.
function pickAdapter(kind: IntegrationKind, conn: ConnectionInfo | null): ConnectorAdapter {
  if (conn && !conn.isMock && graphConfigured()) {
    if (kind === 'email') return graphEmail;
    if (kind === 'teams') return graphTeams;
  }
  return getAdapter(kind);
}

// IntegrationKind (tool target) → integration_type rows that can satisfy it.
const KIND_TO_TYPE: Partial<Record<IntegrationKind, string>> = {
  email: 'graph_email',
  calendar: 'graph_calendar',
  teams: 'graph_teams',
  devops: 'ado_org',
  github: 'github',
  opsconnect: 'opsconnect',
  business_central: 'business_central',
  crm: 'crm',
};

@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  // Resolve the connection (integrations row) a tool_call should target.
  private async resolveConnection(tool: ToolName, args: any, explicitId?: string | null): Promise<ConnectionInfo | null> {
    const kind = TOOL_REGISTRY[tool].targets;
    if (kind === 'internal') return null;
    if (explicitId) {
      const row = await this.prisma.integrations.findUnique({ where: { id: explicitId } });
      if (row) return this.toInfo(row);
    }
    const type = KIND_TO_TYPE[kind];
    if (!type) return null;
    const candidates = await this.prisma.integrations.findMany({ where: { type: type as any } });
    if (!candidates.length) return null;
    // For Business Central, pick by company hint in args.
    if (kind === 'business_central' && args?.company) {
      const match = candidates.find((c) => (c.config as any)?.company === args.company);
      if (match) return this.toInfo(match);
    }
    return this.toInfo(candidates[0]);
  }

  private toInfo(row: any): ConnectionInfo {
    return { id: row.id, type: row.type, name: row.name, config: (row.config as any) ?? {}, isMock: row.is_mock };
  }

  // Execute a single tool_call. Called by approvals.approve (sensitive) and by
  // the worker for auto-approved low-risk intents (via internal endpoint).
  async executeToolCall(toolCallId: string, actorUserId?: string | null): Promise<{ status: string; result: any }> {
    const tc = await this.prisma.tool_calls.findUnique({ where: { id: toolCallId }, include: { agent_run: true } });
    if (!tc) return { status: 'failed', result: { error: 'tool_call not found' } };
    if (!isKnownTool(tc.name)) {
      await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { status: 'failed', error: `unknown tool ${tc.name}` } });
      return { status: 'failed', result: { error: 'unknown tool' } };
    }

    const tool = tc.name as ToolName;
    const args = (tc.args as any) ?? {};
    const activityId = tc.agent_run?.activity_id;
    // Bind the tool_call's workspace so executor-created rows (messages/tasks/
    // audit) are stamped — covers both the request path and the internal worker path.
    const wsId = (tc.agent_run as any)?.workspace_id;
    if (wsId) tenantStore.enterWith({ workspaceId: wsId });

    await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { status: 'executing' } });

    try {
      const conn = await this.resolveConnection(tool, args, tc.target_integration_id);
      const kind = TOOL_REGISTRY[tool].targets;

      let result: any;
      if (kind === 'internal') {
        result = await this.executeInternal(tool, args, { activityId, workspaceId: wsId ?? null, sourceResourceId: (tc.agent_run as any)?.ai_resource_id ?? null });
      } else if (!conn) {
        result = { ok: false, detail: `no connection of kind ${kind} configured` };
      } else {
        const adapter = pickAdapter(kind, conn);
        result = await adapter.execute(tool, args, conn);
        // Side effects that also belong in our own DB:
        if (tool === 'send_email' || tool === 'send_proposal') {
          await this.recordOutboundMessage(activityId, args, conn.name);
        }
        // attribute outbound connection for counting
        await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { target_integration_id: conn.id } });
      }

      const ok = result?.ok !== false;
      await this.prisma.tool_calls.update({
        where: { id: toolCallId },
        data: { status: ok ? 'succeeded' : 'failed', result, executed_by: actorUserId ?? undefined, executed_at: new Date() },
      });
      await this.audit.log({
        actorType: actorUserId ? 'user' : 'system',
        actorUserId: actorUserId ?? null,
        action: 'execute',
        entityType: 'tool_calls',
        entityId: toolCallId,
        activityId,
        summary: `Executed ${tool}${conn ? ` via ${conn.name}` : ''}`,
        after: result,
      });
      this.logger.log(`tool_call ${toolCallId} (${tool}) → ${ok ? 'succeeded' : 'failed'}`);
      return { status: ok ? 'succeeded' : 'failed', result };
    } catch (e) {
      const error = (e as Error).message;
      await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { status: 'failed', error } });
      return { status: 'failed', result: { error } };
    }
  }

  // Cap chained handoffs so cross-department automation can't loop forever.
  private static readonly MAX_HANDOFF_DEPTH = 3;

  private async executeInternal(
    tool: ToolName,
    args: any,
    ctx: { activityId?: string; workspaceId?: string | null; sourceResourceId?: string | null },
  ) {
    const { activityId, workspaceId, sourceResourceId } = ctx;
    if (tool === 'create_task') {
      const task = await this.prisma.tasks.create({
        data: {
          workspace_id: workspaceId ?? undefined,
          activity_id: activityId,
          assignee_resource_id: sourceResourceId ?? undefined,
          title: String(args.title ?? 'Follow-up'),
          description: args.description ?? args.detail ?? null,
          status: 'open',
          metadata: { source: 'agent', proactive: !!args.proactive },
        },
      });
      return { ok: true, external_id: task.id, detail: 'Internal task created' };
    }
    if (tool === 'create_document') {
      const title = String(args.title ?? args.name ?? 'Draft document').slice(0, 400);
      const content = String(args.content ?? args.body ?? args.text ?? '').trim();
      const doc = await this.prisma.documents.create({
        data: {
          workspace_id: workspaceId ?? undefined,
          activity_id: activityId,
          title,
          source_type: 'agent_draft',
          mime_type: 'text/markdown',
          status: 'uploaded',
          size_bytes: content.length || null,
          metadata: { source: 'agent', kind: args.kind ?? 'document', content },
        },
      });
      return { ok: true, external_id: doc.id, detail: 'Document draft created' };
    }
    if (tool === 'handoff') {
      return this.executeHandoff(args, { activityId, workspaceId, sourceResourceId });
    }
    if (tool === 'rag_search') {
      return { ok: true, detail: 'rag_search is read-only; performed during reasoning' };
    }
    return { ok: true, detail: `${tool} (internal, no-op)` };
  }

  // Real cross-department handoff: spawn a `proactive` activity pinned to the
  // target resource and enqueue it through the normal pipeline. This is how the
  // departments interact automatically. Guarded by a chain-depth cap.
  private async executeHandoff(
    args: any,
    ctx: { activityId?: string; workspaceId?: string | null; sourceResourceId?: string | null },
  ) {
    const { activityId, workspaceId, sourceResourceId } = ctx;
    const target = String(args.to ?? args.resource ?? args.target ?? '').trim();
    if (!target) return { ok: false, detail: 'handoff missing target (args.to)' };

    const resource = await this.prisma.ai_resources.findFirst({
      where: { OR: [{ key: target }, { name: target }], status: 'active' },
    });
    if (!resource) return { ok: false, detail: `handoff target "${target}" not found` };

    // Depth from the parent activity's metadata; stop runaway chains.
    let depth = 0;
    if (activityId) {
      const parent = await this.prisma.activities.findUnique({ where: { id: activityId } });
      depth = Number((parent?.metadata as any)?.handoff_depth ?? 0);
    }
    if (depth >= ExecutorService.MAX_HANDOFF_DEPTH) {
      return { ok: true, detail: `handoff to ${resource.name} skipped (max chain depth ${ExecutorService.MAX_HANDOFF_DEPTH})` };
    }

    const subject = String(args.subject ?? args.title ?? `Handoff: ${resource.role ?? resource.name}`).slice(0, 480);
    const body = String(args.note ?? args.body ?? args.rationale ?? args.context ?? args.objective ?? 'Cross-department handoff from a teammate.');
    const activity = await this.prisma.activities.create({
      data: {
        workspace_id: workspaceId ?? undefined,
        channel: 'proactive',
        subject,
        body,
        status: 'new',
        assigned_resource_id: resource.id,
        metadata: { proactive: true, handoff: true, handoff_from_resource_id: sourceResourceId ?? null, handoff_depth: depth + 1 },
      },
    });
    await this.queue.enqueueActivity(activity.id);
    return { ok: true, external_id: activity.id, detail: `Handed off to ${resource.name}` };
  }

  private async recordOutboundMessage(activityId: string | undefined, args: any, connName: string) {
    if (!activityId) return;
    await this.prisma.messages.create({
      data: {
        activity_id: activityId,
        direction: 'outbound',
        channel: 'email',
        author_type: 'ai_resource',
        to_addresses: (args.to ?? args.recipients ?? []) as any,
        subject: args.subject ?? null,
        body: args.body ?? args.content ?? null,
        is_draft: false,
        sent_at: new Date(),
        metadata: { via: connName },
      },
    });
  }
}
