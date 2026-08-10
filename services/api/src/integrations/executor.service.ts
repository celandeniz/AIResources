import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { AuditService } from '../common/audit.service';
import { getAdapter } from './mock-adapters';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { GraphTeamsAdapter } from './graph/graph-teams.adapter';
import { graphConfigured } from './graph/graph-client';
import { whatsAppAdapter, whatsappConfigured } from './whatsapp/whatsapp.adapter';
import { devOpsAdapter, devopsConfigured } from './devops/devops.adapter';
import { gitHubAdapter, githubConfigured } from './github/github.adapter';
import { businessCentralAdapter, bcConfigured } from './bc/bc.adapter';
import { runCodeTask } from './opencode/opencode.client';
import { TOOL_REGISTRY, isKnownTool, IntegrationKind, ToolName } from '@dynops/shared';
import { tenantStore } from '../common/tenant';
import type { ConnectorAdapter, ConnectionInfo } from './contracts';
import { runReport } from '../modules/analyst/reports.service';
import { runGuardHooks } from './guard-hooks';

const graphEmail = new GraphEmailAdapter();
const graphTeams = new GraphTeamsAdapter();

// Real adapter when the connection is live (is_mock=false) and the relevant
// credential set is configured; else fall through to the mock adapter.
function pickAdapter(kind: IntegrationKind, conn: ConnectionInfo | null): ConnectorAdapter {
  if (conn && !conn.isMock) {
    if ((kind === 'email' || kind === 'teams') && graphConfigured()) {
      if (kind === 'email') return graphEmail;
      if (kind === 'teams') return graphTeams;
    }
    if (kind === 'whatsapp' && whatsappConfigured()) {
      return whatsAppAdapter;
    }
    if (kind === 'devops' && devopsConfigured()) return devOpsAdapter;
    if (kind === 'github' && githubConfigured()) return gitHubAdapter;
    if (kind === 'business_central' && bcConfigured()) return businessCentralAdapter;
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
  whatsapp: 'whatsapp',
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
    // Prefer a LIVE connection (is_mock=false) over a mock one — otherwise a
    // real send/action can silently route to the mock adapter (findMany order
    // is non-deterministic when both a mock and a live row exist for a type).
    const live = candidates.find((c) => !c.is_mock);
    return this.toInfo(live ?? candidates[0]);
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

    // WhatsApp replies: if the agent didn't specify a recipient, resolve it from
    // the originating activity (the sender's phone is stored as conversation_id).
    if (tool === 'send_whatsapp_message' && !args.to && activityId) {
      const act = await this.prisma.activities.findUnique({ where: { id: activityId } });
      const meta = (act?.metadata as any) ?? {};
      args.to = meta.conversation_id ?? meta.wa_from ?? (typeof meta.from === 'string' ? (meta.from.match(/\d{6,}/)?.[0]) : undefined);
    }

    // Guard hooks (deterministic policy enforcement outside the model):
    // block → fail the tool_call with the reason; warn → proceed + audit.
    const guard = await runGuardHooks(this.prisma, wsId ?? null, tool, args);
    if (!guard.allowed) {
      await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { status: 'failed', error: guard.reason } });
      await this.audit.log({
        actorType: 'system', action: 'reject', entityType: 'tool_calls', entityId: toolCallId, activityId,
        summary: `Guard hook blocked ${tool}: ${guard.reason}`,
      });
      return { status: 'failed', result: { error: guard.reason, guard_blocked: true } };
    }
    for (const w of guard.warnings) {
      await this.audit.log({
        actorType: 'system', action: 'execute', entityType: 'tool_calls', entityId: toolCallId, activityId,
        summary: `Guard warning on ${tool}: ${w}`,
      });
    }

    await this.prisma.tool_calls.update({ where: { id: toolCallId }, data: { status: 'executing' } });

    try {
      const conn = await this.resolveConnection(tool, args, tc.target_integration_id);
      const kind = TOOL_REGISTRY[tool].targets;

      let result: any;
      if (kind === 'internal') {
        result = await this.executeInternal(tool, args, { activityId, workspaceId: wsId ?? null, sourceResourceId: (tc.agent_run as any)?.ai_resource_id ?? null });
        // code_task: persist the OpenCode result back onto the code_tasks row,
        // and surface it in the mission war-room feed when pod-driven.
        if (tool === 'code_task' && args.code_task_id) {
          try {
            const ct = (result?.result ?? {}) as any;
            await (this.prisma as any).code_tasks.updateMany({
              where: { id: args.code_task_id },
              data: {
                status: ct.ok ? 'done' : 'failed',
                result: ct as any,
                share_url: ct.shareUrl ?? null,
              },
            });
            if (args.mission_id) {
              await (this.prisma as any).agent_messages.create({
                data: {
                  workspace_id: wsId ?? undefined,
                  mission_id: args.mission_id,
                  from_resource_id: (tc.agent_run as any)?.ai_resource_id ?? null,
                  kind: 'status',
                  body: `code_task ${ct.ok ? (ct.mock ? 'OK (mock)' : 'OK') : 'FAILED'} — ${(ct.summary ?? ct.detail ?? '').slice(0, 1500)}${ct.shareUrl ? `\n${ct.shareUrl}` : ''}`,
                  metadata: { code_task_id: args.code_task_id, diff_bytes: (ct.diff ?? '').length },
                },
              });
            }
          } catch { /* non-critical */ }
        }
      } else if (!conn) {
        result = { ok: false, detail: `no connection of kind ${kind} configured` };
      } else {
        const adapter = pickAdapter(kind, conn);
        result = await adapter.execute(tool, args, conn);
        // Side effects that also belong in our own DB:
        if (tool === 'send_email' || tool === 'send_proposal') {
          await this.recordOutboundMessage(activityId, args, conn.name, 'email');
        }
        if (tool === 'send_whatsapp_message') {
          await this.recordOutboundMessage(activityId, args, conn.name, 'whatsapp');
        }
        // BC sales order: update the report to 'ordered' and store the BC ref
        if (tool === 'bc_create_sales_order' && result?.ok && args.report_id) {
          try {
            await (this.prisma as any).reports.updateMany({
              where: { id: args.report_id },
              data: {
                status: 'ordered',
                bc_order: {
                  external_id: result.external_id ?? null,
                  company: args.company ?? null,
                  detail: result.detail ?? null,
                  ordered_at: new Date().toISOString(),
                } as any,
              },
            });
          } catch { /* non-critical */ }
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
    if (tool === 'post_message') {
      // Inter-agent message into the mission feed (blackboard). Resolves the
      // mission from the source activity's metadata.
      let missionId: string | null = null;
      if (activityId) {
        const act = await this.prisma.activities.findUnique({ where: { id: activityId } });
        missionId = ((act?.metadata as any)?.mission_id as string) ?? null;
      }
      const body = String(args.body ?? args.message ?? args.text ?? '').slice(0, 4000);
      if (!body) return { ok: false, detail: 'post_message requires a body' };
      await (this.prisma as any).agent_messages.create({
        data: {
          workspace_id: workspaceId ?? undefined,
          mission_id: missionId,
          from_resource_id: sourceResourceId ?? null,
          to_resource_id: (args.to as string) ?? null,
          kind: 'status',
          body,
        },
      });
      return { ok: true, detail: 'Posted to mission feed' };
    }
    if (tool === 'rag_search') {
      return { ok: true, detail: 'rag_search is read-only; performed during reasoning' };
    }
    if (tool === 'run_report') {
      const reportKey = String(args.report ?? '').trim();
      if (!reportKey) return { ok: false, detail: 'run_report requires args.report' };
      try {
        const result = await runReport(this.prisma, reportKey, args.params ?? {});
        return { ok: true, result };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }
    if (tool === 'code_task') {
      const r = await runCodeTask({
        instruction: String(args.instruction ?? ''),
        model: args.model,
        agent: args.agent,
        repo: args.repo,
        branch: args.branch,
      });
      return { ok: r.ok, detail: r.detail ?? r.summary?.slice(0, 200), result: r };
    }
    if (tool === 'phone_task') {
      const commandId = args.device_command_id as string | undefined;
      if (!commandId) return { ok: false, detail: 'phone_task missing device_command_id' };
      const cmd = await (this.prisma as any).device_commands.findUnique({ where: { id: commandId } });
      return {
        ok: true,
        detail: `Phone task queued for device execution (status: ${cmd?.status ?? 'unknown'})`,
        result: { device_command_id: commandId, status: cmd?.status ?? 'unknown' },
      };
    }
    if (tool === 'make_chart') {
      const type = args.type && ['bar', 'donut', 'line'].includes(String(args.type)) ? String(args.type) : 'bar';
      return { ok: true, chart: { type, title: args.title ?? 'Chart', ...args } };
    }
    if (tool === 'remember') {
      const content = String(args.content ?? args.note ?? args.text ?? '').trim();
      if (!content) return { ok: false, detail: 'remember requires content' };
      // Resolve customer_id from activity when available
      let customerId: string | null = null;
      if (activityId) {
        const act = await this.prisma.activities.findUnique({ where: { id: activityId }, select: { customer_id: true } });
        customerId = act?.customer_id ?? null;
      }
      await (this.prisma as any).resource_memories.create({
        data: {
          workspace_id: workspaceId ?? undefined,
          // scope 'workspace' → Memory Vault entry (resource_id null, shared by
          // every resource); anything else stays private to the source resource.
          resource_id: (args.scope as string) === 'workspace' ? null : sourceResourceId ?? undefined,
          customer_id: customerId ?? undefined,
          scope: (args.scope as string) ?? 'general',
          content,
          source_activity_id: activityId ?? undefined,
        },
      });
      return { ok: true, detail: 'Saved to memory' };
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

  private async recordOutboundMessage(activityId: string | undefined, args: any, connName: string, channel: 'email' | 'whatsapp' = 'email') {
    if (!activityId) return;
    // For WhatsApp, `to` is a single phone number string; wrap it in an array for
    // consistency with the messages.to_addresses Json field.
    const toAddresses = channel === 'whatsapp'
      ? [String(args.to ?? '')].filter(Boolean)
      : ((args.to ?? args.recipients ?? []) as any);
    await this.prisma.messages.create({
      data: {
        activity_id: activityId,
        direction: 'outbound',
        channel,
        author_type: 'ai_resource',
        to_addresses: toAddresses as any,
        subject: args.subject ?? null,
        body: args.body ?? args.message ?? args.content ?? null,
        is_draft: false,
        sent_at: new Date(),
        metadata: { via: connName },
      },
    });
  }
}
