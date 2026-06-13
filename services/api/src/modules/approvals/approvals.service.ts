import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { ExecutorService } from '../../integrations/executor.service';
import { QueueService } from '../../queue/queue.service';
import { emitStreamEvent } from '../../common/events';
import type { AuthUser } from '../../auth/decorators';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

// Actions that carry an AI-drafted outbound answer (the "AI answers" filter).
export const MESSAGE_ACTIONS = ['send_email', 'send_proposal', 'send_whatsapp_message', 'send_teams_message', 'post_message'];

// Read the AI's draft answer text out of a tool_call's args (the field name
// varies by action).
function readDraftText(args: any): string {
  if (!args || typeof args !== 'object') return '';
  return String(args.content ?? args.body ?? args.message ?? args.text ?? '');
}

// Prisma select for the originating activity context shown on each approval:
// data source (channel + connection), sender, original message, customer.
const ORIGIN_ACTIVITY_SELECT = {
  id: true,
  subject: true,
  body: true,
  channel: true,
  customer_id: true,
  metadata: true,
  source: { select: { name: true, channel: true, integration: { select: { name: true, type: true } } } },
  customer: { select: { name: true } },
  messages: {
    where: { direction: 'inbound' as const },
    orderBy: { created_at: 'asc' as const },
    take: 1,
    select: { from_address: true, subject: true, body: true, created_at: true },
  },
} as const;

// Normalize a tool_call `to`/recipient arg (array or string) into one string.
function joinRecipient(to: any): string | null {
  if (to == null) return null;
  if (Array.isArray(to)) { const j = to.filter(Boolean).join(', '); return j || null; }
  const s = String(to).trim();
  return s || null;
}

// Build a clean "where did this approval come from" object for the UI:
// data source / who sent it / the original message / where it was triggered.
// `approval` (optional) surfaces the outbound recipient (Kime) + reply identity
// (Kim olarak) stamped by the worker.
function buildOrigin(activity: any, approval?: any) {
  if (!activity) return null;
  const meta = (activity.metadata as any) ?? {};
  const inbound = Array.isArray(activity.messages) ? activity.messages[0] : null;
  const integration = activity.source?.integration ?? null;
  const payload = (approval?.payload as any) ?? {};
  const recipient = joinRecipient(approval?.tool_call?.args?.to ?? payload.recipient);
  const replyAs = payload.reply_as ?? null;
  return {
    recipient,
    reply_as: replyAs && (replyAs.name || replyAs.email) ? { name: replyAs.name ?? null, email: replyAs.email ?? null } : null,
    channel: activity.channel, // email | teams | whatsapp | devops | manual | …
    source_name: activity.source?.name ?? integration?.name ?? null, // which connection/mailbox triggered it
    integration_type: integration?.type ?? null,
    from: meta.from ?? inbound?.from_address ?? null, // who sent it
    to: meta.to ?? null,
    conversation_id: meta.conversation_id ?? null,
    customer: activity.customer?.name ?? null,
    subject: inbound?.subject ?? activity.subject ?? null,
    original_message: inbound?.body ?? activity.body ?? null, // the original message
    received_at: inbound?.created_at ?? null,
    system_generated: Boolean(meta.system_generated),
    system_reason: meta.system_reason ?? null,
  };
}

export interface ApprovalFilters {
  status?: string;
  riskLevel?: string;
  aiResourceId?: string;
  model?: string;
  subject?: string;
  aiAnswersOnly?: boolean;
  hideSystem?: boolean; // default true
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly executor: ExecutorService,
    private readonly queue: QueueService,
  ) {}

  async list(filters: ApprovalFilters) {
    const where: any = {};
    if (filters.status) where.status = filters.status;
    if (filters.riskLevel) where.risk_level = filters.riskLevel;
    if (filters.aiAnswersOnly) where.action = { in: MESSAGE_ACTIONS };

    // Relation filters (AI resource / model live on agent_run; subject on activity)
    const agentRunWhere: any = {};
    if (filters.aiResourceId) agentRunWhere.ai_resource_id = filters.aiResourceId;
    if (filters.model) agentRunWhere.llm_model = filters.model;
    if (Object.keys(agentRunWhere).length) where.agent_run = { is: agentRunWhere };

    if (filters.subject) where.activity = { is: { subject: { contains: filters.subject, mode: 'insensitive' } } };

    const rows = await this.prisma.approvals.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        tool_call: true,
        activity: { select: ORIGIN_ACTIVITY_SELECT },
        agent_run: {
          select: {
            id: true, ai_resource_id: true, llm_model: true, llm_provider: true,
            reasoning_summary: true, confidence_score: true,
            ai_resource: { select: { name: true, key: true } },
          },
        },
      },
    });

    // Surface the editable draft text, the origin context, and a system flag.
    const mapped = rows.map((r) => ({
      ...r,
      draft_text: readDraftText(r.tool_call?.args),
      is_ai_answer: MESSAGE_ACTIONS.includes(r.action),
      origin: buildOrigin(r.activity, r),
      system_generated: Boolean((r.activity?.metadata as any)?.system_generated),
    }));
    // Hide system-generated by default. Done in JS (not SQL) because a JSON
    // `NOT path equals true` drops rows where the key is ABSENT (Postgres NULL
    // three-valued logic) — which would hide everything.
    return filters.hideSystem !== false ? mapped.filter((r) => !r.system_generated) : mapped;
  }

  // Distinct AI resources and models present among approvals — drives the filter dropdowns.
  async filterOptions() {
    const runs = await this.prisma.agent_runs.findMany({
      where: { approvals: { some: {} } },
      select: { ai_resource_id: true, llm_model: true, ai_resource: { select: { name: true } } },
    });
    const resourceMap = new Map<string, string>();
    const models = new Set<string>();
    for (const r of runs) {
      if (r.ai_resource_id) resourceMap.set(r.ai_resource_id, r.ai_resource?.name ?? r.ai_resource_id);
      if (r.llm_model) models.add(r.llm_model);
    }
    return {
      resources: [...resourceMap].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      models: [...models].sort(),
    };
  }

  async get(id: string) {
    const a = await this.prisma.approvals.findUnique({
      where: { id },
      include: {
        tool_call: true,
        activity: { select: ORIGIN_ACTIVITY_SELECT },
        agent_run: { include: { ai_resource: { select: { name: true, key: true } } } },
      },
    });
    if (!a) throw new NotFoundException('approval not found');
    return { ...a, draft_text: readDraftText(a.tool_call?.args), is_ai_answer: MESSAGE_ACTIONS.includes(a.action), origin: buildOrigin(a.activity, a) };
  }

  // Save an edited AI answer onto the pending tool_call (no execution yet).
  async saveDraft(id: string, user: AuthUser, body: { content: string; subject?: string }) {
    const approval = await this.prisma.approvals.findUnique({ where: { id }, include: { tool_call: true } });
    if (!approval) throw new NotFoundException('approval not found');
    if (approval.status !== 'pending') throw new ForbiddenException(`approval is ${approval.status}`);
    if (!approval.tool_call) throw new BadRequestException('approval has no editable action');
    const content = String(body?.content ?? '');
    const args: any = { ...(approval.tool_call.args as any) };
    // Write to whichever field this action uses (default content + body).
    if ('content' in args || !('body' in args)) args.content = content;
    if ('body' in args) args.body = content;
    if ('message' in args) args.message = content;
    if ('text' in args) args.text = content;
    if (body.subject !== undefined && 'subject' in args) args.subject = body.subject;
    await this.prisma.tool_calls.update({ where: { id: approval.tool_call.id }, data: { args } });
    // Mirror into the approval payload so the card preview stays in sync.
    const payload: any = { ...(approval.payload as any), content, ...(body.subject !== undefined ? { subject: body.subject } : {}) };
    await this.prisma.approvals.update({ where: { id }, data: { payload } });
    await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'update', entityType: 'approvals', entityId: id, activityId: approval.activity_id, summary: `Edited draft for ${approval.action}` });
    return this.get(id);
  }

  // Regenerate the AI answer using the original activity context + a short
  // human instruction. Re-runs the same AI resource and overwrites the draft.
  async regenerate(id: string, user: AuthUser, instruction: string) {
    const approval = await this.prisma.approvals.findUnique({
      where: { id },
      include: { tool_call: true, activity: true, agent_run: { include: { ai_resource: true } } },
    });
    if (!approval) throw new NotFoundException('approval not found');
    if (approval.status !== 'pending') throw new ForbiddenException(`approval is ${approval.status}`);
    if (!approval.tool_call) throw new BadRequestException('approval has no editable action');
    const instr = String(instruction ?? '').trim();
    if (!instr) throw new BadRequestException('instruction is required');

    // Prefer the original AI resource; fall back to the executive assistant persona.
    const resource =
      approval.agent_run?.ai_resource ??
      (await this.prisma.ai_resources.findUnique({ where: { key: 'ai_executive_assistant' } }));
    if (!resource) throw new BadRequestException('no AI resource available to regenerate');

    const activity = approval.activity;
    const prevDraft = readDraftText(approval.tool_call.args);
    const fromAddr = (activity?.metadata as any)?.from ?? '';

    const body =
      `Aşağıdaki gelen mesaja verdiğin yanıtı, kullanıcının revize talimatına göre yeniden yaz.\n\n` +
      `=== GELEN MESAJ ===\n` +
      `Kimden: ${fromAddr}\nKonu: ${activity?.subject ?? ''}\n\n${activity?.body ?? ''}\n\n` +
      `=== MEVCUT TASLAK YANIT ===\n${prevDraft || '(yok)'}\n\n` +
      `=== REVİZE TALİMATI ===\n${instr}\n\n` +
      `Yalnızca yeni yanıt metnini draft.content alanına yaz. Aynı dilde ve profesyonel bir tonda yaz.`;

    const req = {
      run_id: `approval-regen-${Date.now()}`,
      workspace_id: approval.workspace_id ?? undefined,
      ai_resource: {
        key: resource.key,
        name: resource.name,
        system_prompt: resource.system_prompt,
        provider: resource.llm_provider,
        model: resource.llm_model,
        temperature: Number(resource.temperature),
        tools: [],
        confidence_threshold: Number(resource.confidence_threshold),
      },
      activity: {
        id: activity?.id ?? `approval-${id}`,
        channel: (activity?.channel as any) ?? 'manual',
        subject: activity?.subject ?? '',
        body,
        priority: 'normal',
        customer: null,
      },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
    };

    let resp: any;
    try {
      const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
      resp = await res.json();
    } catch (e) {
      throw new BadRequestException(`Regenerate failed: ${(e as Error).message}`);
    }

    const newText = String(resp?.draft?.content ?? '').trim();
    if (!newText) throw new BadRequestException('Agent returned an empty draft');

    // Persist the new draft onto the tool_call + payload + agent_run reasoning.
    const args: any = { ...(approval.tool_call.args as any) };
    if ('content' in args || !('body' in args)) args.content = newText;
    if ('body' in args) args.body = newText;
    if ('message' in args) args.message = newText;
    if ('text' in args) args.text = newText;
    await this.prisma.tool_calls.update({ where: { id: approval.tool_call.id }, data: { args } });
    await this.prisma.approvals.update({ where: { id }, data: { payload: { ...(approval.payload as any), content: newText } } });
    if (approval.agent_run_id) {
      await this.prisma.agent_runs.update({
        where: { id: approval.agent_run_id },
        data: { reasoning_summary: `Yanıt revize edildi (talimat: ${instr.slice(0, 120)})` },
      });
    }
    await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'draft', entityType: 'approvals', entityId: id, activityId: approval.activity_id, summary: `Regenerated draft for ${approval.action}` });
    return this.get(id);
  }

  // Meeting-specific: ask the original AI resource to draft a polite reply that
  // PROPOSES AN ALTERNATIVE TIME, then write that text onto the calendar
  // tool_call (body/content) and best-effort move its start/end to `newTime`.
  async proposeMeetingTime(id: string, user: AuthUser, newTime: string, note?: string) {
    const approval = await this.prisma.approvals.findUnique({
      where: { id },
      include: { tool_call: true, activity: true, agent_run: { include: { ai_resource: true } } },
    });
    if (!approval) throw new NotFoundException('approval not found');
    if (approval.status !== 'pending') throw new ForbiddenException(`approval is ${approval.status}`);
    if (!approval.tool_call) throw new BadRequestException('approval has no editable action');
    const when = String(newTime ?? '').trim();
    if (!when) throw new BadRequestException('newTime is required');

    const resource =
      approval.agent_run?.ai_resource ??
      (await this.prisma.ai_resources.findUnique({ where: { key: 'ai_executive_assistant' } }));
    if (!resource) throw new BadRequestException('no AI resource available');

    const activity = approval.activity;
    const args: any = { ...(approval.tool_call.args as any) };
    const origStart = args.start ?? args.startTime ?? null;

    const body =
      `Aşağıdaki toplantı talebine, önerilen yeni bir zaman sunan nazik bir yanıt taslağı yaz.\n\n` +
      `=== TOPLANTI TALEBİ ===\n` +
      `Konu: ${activity?.subject ?? args.subject ?? args.title ?? ''}\n` +
      `Mevcut önerilen zaman: ${origStart ?? '(belirtilmemiş)'}\n\n${activity?.body ?? ''}\n\n` +
      `Önerilen yeni zaman: ${when}. ${note ?? ''}\n\n` +
      `Nazik bir şekilde alternatif zaman öneren bir yanıt taslağı yaz; yalnızca yanıt metnini draft.content alanına koy.`;

    const req = {
      run_id: `meeting-propose-${Date.now()}`,
      workspace_id: approval.workspace_id ?? undefined,
      ai_resource: {
        key: resource.key,
        name: resource.name,
        system_prompt: resource.system_prompt,
        provider: resource.llm_provider,
        model: resource.llm_model,
        temperature: Number(resource.temperature),
        tools: [],
        confidence_threshold: Number(resource.confidence_threshold),
      },
      activity: {
        id: activity?.id ?? `approval-${id}`,
        channel: (activity?.channel as any) ?? 'manual',
        subject: activity?.subject ?? '',
        body,
        priority: 'normal',
        customer: null,
      },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
    };

    let resp: any;
    try {
      const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
      resp = await res.json();
    } catch (e) {
      throw new BadRequestException(`Propose-time failed: ${(e as Error).message}`);
    }

    const newText = String(resp?.draft?.content ?? '').trim();
    if (!newText) throw new BadRequestException('Agent returned an empty draft');

    // Write the drafted reply onto the tool_call body/content + move start/end.
    if ('content' in args || !('body' in args)) args.content = newText;
    if ('body' in args) args.body = newText;
    // Best-effort ISO: accept datetime-local ("YYYY-MM-DDTHH:mm") or full ISO.
    const iso = (() => { const d = new Date(when); return isNaN(d.getTime()) ? when : d.toISOString(); })();
    if ('start' in args || 'startTime' in args) {
      if ('start' in args) args.start = iso; else args.startTime = iso;
    }
    if ('end' in args || 'endTime' in args) {
      // Preserve the original duration when we can; else leave the existing end.
      const startMs = origStart ? new Date(origStart).getTime() : NaN;
      const endMs = new Date(args.end ?? args.endTime ?? '').getTime();
      const newStart = new Date(iso).getTime();
      if (!isNaN(startMs) && !isNaN(endMs) && !isNaN(newStart)) {
        const endIso = new Date(newStart + (endMs - startMs)).toISOString();
        if ('end' in args) args.end = endIso; else args.endTime = endIso;
      }
    }
    await this.prisma.tool_calls.update({ where: { id: approval.tool_call.id }, data: { args } });
    await this.prisma.approvals.update({ where: { id }, data: { payload: { ...(approval.payload as any), content: newText, proposed_time: iso } } });
    await this.audit.log({ actorType: 'user', actorUserId: user.id, action: 'draft', entityType: 'approvals', entityId: id, activityId: approval.activity_id, summary: `Proposed alternative meeting time` });
    return this.get(id);
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
      const act = await this.prisma.activities.update({ where: { id: activityId }, data: { status: 'completed', completed_at: new Date() } });
      // If this activity is a mission task whose deliverable was approval-gated,
      // the worker never got to advance the mission graph (it only advances after
      // the activity job, which finished in 'awaiting_approval'). Hand it back to
      // the worker so the task is marked done and dependent tasks / the synthesis
      // (and the final write-back to the originating ticket) can proceed.
      const meta = (act.metadata as any) ?? {};
      if (meta.mission_id && meta.task_id) {
        await this.queue.enqueueMissionAdvance(activityId).catch(() => {});
      }
    }
  }
}
