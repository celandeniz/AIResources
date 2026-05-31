import { PrismaClient } from '@dynops/db';
import { TOOL_REGISTRY, isKnownTool, type AgentRunRequest } from '@dynops/shared';
import { matchRoutingRule, type RuleRow } from './rules';
import { runAgent, executeToolCallViaApi } from './agent-client';

const prisma = new PrismaClient();

function flatActivityRecord(a: any): Record<string, any> {
  return {
    channel: a.channel,
    subject: a.subject ?? '',
    body: a.body ?? '',
    category: a.category ?? '',
    customer_id: a.customer_id ?? null,
    project_id: a.project_id ?? null,
    priority: a.priority,
    type: a.channel === 'document' ? 'document_uploaded' : a.channel,
  };
}

async function audit(input: { action: any; entityType: string; entityId?: string; activityId?: string; actorResourceId?: string | null; summary?: string; after?: any; workspaceId?: string | null }) {
  await prisma.audit_logs.create({
    data: {
      workspace_id: input.workspaceId ?? null,
      actor_type: input.actorResourceId ? 'ai_resource' : 'system',
      actor_resource_id: input.actorResourceId ?? null,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      activity_id: input.activityId ?? null,
      summary: input.summary ?? null,
      after: input.after ?? undefined,
    },
  });
}

async function notify(input: { workspaceId?: string | null; type: string; title: string; message: string; metadata?: any }) {
  await (prisma as any).notifications.create({
    data: {
      workspace_id: input.workspaceId ?? null,
      type: input.type,
      title: input.title,
      message: input.message,
      metadata: input.metadata ?? undefined,
    },
  });
}

export async function processActivity(activityId: string) {
  const activity = await prisma.activities.findUnique({
    where: { id: activityId },
    include: { customer: true, project: true, messages: { orderBy: { created_at: 'asc' } }, assigned_resource: true },
  });
  if (!activity) throw new Error(`activity ${activityId} not found`);
  const wsId = activity.workspace_id; // tenant scope for all writes in this job

  // ── 1. Routing (pre_agent rules) ───────────────────────────────────────
  let resourceId = activity.assigned_resource_id;
  let matchedRuleId: string | null = activity.workflow_rule_id;
  if (!resourceId) {
    const rules = (await prisma.workflow_rules.findMany({ where: { is_active: true, workspace_id: wsId } })) as unknown as RuleRow[];
    const rule = matchRoutingRule(rules, flatActivityRecord(activity));
    if (rule?.target_resource_id) {
      resourceId = rule.target_resource_id;
      matchedRuleId = rule.id;
      await prisma.activities.update({
        where: { id: activityId },
        data: { assigned_resource_id: resourceId, workflow_rule_id: rule.id, status: 'routed', routed_at: new Date(), priority: (rule.set_priority as any) ?? activity.priority },
      });
      await audit({ workspaceId: wsId, action: 'route', entityType: 'activities', entityId: activityId, activityId, summary: `Routed via rule "${rule.name}"` });
    }
  }
  if (!resourceId) {
    await prisma.activities.update({ where: { id: activityId }, data: { status: 'escalated' } });
    await audit({ workspaceId: wsId, action: 'escalate', entityType: 'activities', entityId: activityId, activityId, summary: 'No routing rule matched' });
    return;
  }

  const resource = await prisma.ai_resources.findUnique({ where: { id: resourceId } });
  if (!resource) throw new Error(`ai_resource ${resourceId} not found`);
  const threshold = Number(resource.confidence_threshold);
  const approvalLimit = resource.approval_limit !== null ? Number(resource.approval_limit) : null;

  await prisma.activities.update({ where: { id: activityId }, data: { status: 'in_progress' } });

  // ── 2. Build agent request + create agent_run ──────────────────────────
  const run = await prisma.agent_runs.create({
    data: {
      workspace_id: wsId,
      activity_id: activityId,
      ai_resource_id: resource.id,
      customer_id: activity.customer_id,
      project_id: activity.project_id,
      llm_provider: resource.llm_provider,
      llm_model: resource.llm_model,
      status: 'running',
      started_at: new Date(),
    },
  });
  const templates = await (prisma as any).templates.findMany({
    where: { workspace_id: wsId },
    orderBy: { created_at: 'desc' },
    take: 5,
  });

  const req: AgentRunRequest = {
    run_id: run.id,
    workspace_id: wsId ?? undefined,
    ai_resource: {
      key: resource.key,
      name: resource.name,
      system_prompt: resource.system_prompt,
      provider: resource.llm_provider,
      model: resource.llm_model,
      temperature: Number(resource.temperature),
      tools: (resource.allowed_tools as string[]) ?? [],
      confidence_threshold: threshold,
    },
    activity: {
      id: activity.id,
      channel: activity.channel,
      subject: activity.subject,
      body: activity.body,
      priority: activity.priority,
      customer: activity.customer ? { id: activity.customer.id, name: activity.customer.name, tier: activity.customer.tier } : null,
      project: activity.project ? { id: activity.project.id, name: activity.project.name, status: activity.project.status } : null,
      received_at: activity.received_at?.toISOString(),
    },
    context: {
      thread: activity.messages.map((m: any) => ({ role: m.direction === 'inbound' ? 'external' : 'internal', from: m.from_address ?? undefined, text: m.body ?? '' })),
      rag_hints: [],
      rag_hits: templates.map((t: any) => ({ chunk_id: `template:${t.id}`, document_id: t.id, title: `Template: ${t.name}`, score: 1, text: t.content })),
    },
    options: { max_tool_intents: 5 },
  };

  // ── 3. Call the agent (the hybrid seam) ────────────────────────────────
  let resp;
  try {
    resp = await runAgent(req);
  } catch (e) {
    await prisma.agent_runs.update({ where: { id: run.id }, data: { status: 'failed', error: (e as Error).message, finished_at: new Date() } });
    await prisma.activities.update({ where: { id: activityId }, data: { status: 'failed' } });
    throw e;
  }

  const confidence = resp.confidence ?? 0.5;
  await prisma.agent_runs.update({
    where: { id: run.id },
    data: {
      status: 'succeeded',
      output: resp as any,
      reasoning_summary: resp.reasoning_summary,
      confidence_score: confidence,
      tools_used: (resp.tool_intents ?? []).map((t) => t.tool) as any,
      prompt_tokens: resp.token_usage?.input ?? null,
      completion_tokens: resp.token_usage?.output ?? null,
      latency_ms: resp.latency_ms ?? null,
      finished_at: new Date(),
    },
  });
  await prisma.activities.update({ where: { id: activityId }, data: { summary: resp.reasoning_summary, confidence, first_response_at: activity.first_response_at ?? new Date() } });

  // Persist the draft as a draft message (visible in the inbox).
  if (resp.draft?.content) {
    await prisma.messages.create({
      data: {
        workspace_id: wsId,
        activity_id: activityId,
        direction: 'outbound',
        channel: activity.channel,
        author_type: 'ai_resource',
        author_resource_id: resource.id,
        subject: resp.draft.subject ?? activity.subject,
        body: resp.draft.content,
        to_addresses: (resp.draft.recipients ?? []) as any,
        is_draft: true,
      },
    });
  }
  await audit({ workspaceId: wsId, action: 'draft', entityType: 'agent_runs', entityId: run.id, activityId, actorResourceId: resource.id, summary: `Draft by ${resource.name} (confidence ${confidence.toFixed(2)})` });

  // ── 4. Post-agent gates → tool_calls + approvals ───────────────────────
  let createdApproval = false;
  let seq = 0;
  for (const intent of resp.tool_intents ?? []) {
    const def = isKnownTool(intent.tool) ? TOOL_REGISTRY[intent.tool] : undefined;
    const sensitive = def?.sensitive ?? intent.sensitive ?? false;
    const risk = (def?.risk ?? 'medium') as any;
    const monetary = def?.monetary ?? false;
    const amount = monetary && typeof intent.args?.amount === 'number' ? (intent.args.amount as number) : null;
    const overLimit = amount !== null && approvalLimit !== null && amount > approvalLimit;
    const requiresApproval = sensitive || resp.needs_escalation || confidence < threshold || overLimit;

    const toolCall = await prisma.tool_calls.create({
      data: {
        workspace_id: wsId,
        agent_run_id: run.id,
        name: intent.tool,
        args: (intent.args ?? {}) as any,
        requires_approval: requiresApproval,
        risk_level: risk,
        status: requiresApproval ? 'awaiting_approval' : 'approved',
        sequence: seq++,
        target_integration_id: intent.target_integration_id ?? null,
      },
    });

    if (requiresApproval) {
      createdApproval = true;
      await prisma.approvals.create({
        data: {
          workspace_id: wsId,
          activity_id: activityId,
          agent_run_id: run.id,
          tool_call_id: toolCall.id,
          action: intent.tool,
          payload: (intent.args ?? {}) as any,
          risk_level: risk,
          amount: amount ?? undefined,
          reason: resp.needs_escalation ? 'escalation' : confidence < threshold ? 'low_confidence' : 'sensitive_action',
          status: 'pending',
        },
      });
      await notify({
        workspaceId: wsId,
        type: 'approval_created',
        title: `Approval required: ${intent.tool}`,
        message: `${resource.name} proposed ${intent.tool} for "${activity.subject ?? 'activity'}".`,
        metadata: { activityId, agentRunId: run.id, toolCallId: toolCall.id, action: intent.tool },
      });
      await audit({ workspaceId: wsId, action: 'escalate', entityType: 'approvals', activityId, entityId: toolCall.id, summary: `Approval required for ${intent.tool}` });
    } else {
      // auto-execute low-risk intents via the API (owns adapters)
      try {
        await executeToolCallViaApi(toolCall.id);
      } catch (e) {
        await prisma.tool_calls.update({ where: { id: toolCall.id }, data: { status: 'failed', error: (e as Error).message } });
      }
    }
  }

  // ── 5. Final activity status ───────────────────────────────────────────
  if (createdApproval) {
    await prisma.activities.update({ where: { id: activityId }, data: { status: 'awaiting_approval', requires_approval: true } });
  } else if (resp.needs_escalation) {
    await prisma.activities.update({ where: { id: activityId }, data: { status: 'escalated' } });
    await notify({
      workspaceId: wsId,
      type: 'activity_escalated',
      title: 'Activity escalated',
      message: `${resource.name} escalated "${activity.subject ?? 'activity'}".`,
      metadata: { activityId, agentRunId: run.id, aiResourceId: resource.id },
    });
  } else {
    await prisma.activities.update({ where: { id: activityId }, data: { status: 'completed', completed_at: new Date() } });
  }
}
