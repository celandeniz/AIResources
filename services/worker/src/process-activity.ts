import { PrismaClient } from '@dynops/db';
import { TOOL_REGISTRY, isKnownTool, isSensitive, type AgentRunRequest, type ToolName } from '@dynops/shared';
import { matchRoutingRule, type RuleRow } from './rules';
import { runAgent, executeToolCallViaApi } from './agent-client';
import { planAndStartMission } from './mission';

const prisma = new PrismaClient();

// Topic missions: every ADO work-item / support@ email auto-spawns a Mission Pod.
const ENABLE_TOPIC_MISSIONS = process.env.ENABLE_TOPIC_MISSIONS !== 'false';
const SUPPORT_MAILBOXES = (process.env.SUPPORT_MAILBOXES ?? 'support@dynamicsops.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Actions that carry an AI-drafted reply — we prepare 3 toned alternatives for these.
const MESSAGE_ACTIONS = new Set(['send_email', 'send_proposal', 'send_whatsapp_message', 'send_teams_message', 'post_message']);
const ALT_TONES = [
  { label: 'Kısa & net', hint: 'kısa, doğrudan ve net' },
  { label: 'Detaylı & resmi', hint: 'detaylı, resmi ve profesyonel' },
  { label: 'Samimi & ilişki-odaklı', hint: 'sıcak, samimi ve ilişki kuran' },
];

// Generate ≥3 toned alternatives (owner style) for a drafted reply. Each tone is
// a separate, reliable single-draft call (qwen3 is unreliable at emitting 3
// variants in one response), run in parallel.
async function generateAlternatives(opts: {
  wsId: string | null;
  resource: any;
  styleProfileText: string;
  activity: any;
  primaryDraft: string;
}): Promise<{ label: string; content: string }[]> {
  const styleBlock = opts.styleProfileText ? `\n\n## SAHİBİN YANIT STİLİ (bu sesle yaz)\n${opts.styleProfileText}` : '';
  const body =
    `=== GELEN MESAJ ===\nKonu: ${opts.activity?.subject ?? ''}\n\n${opts.activity?.body ?? ''}\n\n` +
    `=== MEVCUT TASLAK (referans) ===\n${opts.primaryDraft}\n\n` +
    `Bu gelen mesaja tek bir yanıt yaz. Yalnızca yanıt metnini draft.content alanına yaz.`;

  const oneTone = async (tone: { label: string; hint: string }): Promise<{ label: string; content: string } | null> => {
    const system =
      `Sen, firma sahibinin sesiyle yanıt yazan bir asistansın. Gelen mesaja ${tone.hint} BİR yanıt yaz. ` +
      `Yanıtı sahibin stiline uygun ve aynı dilde yaz. Sadece yanıt metnini üret.` + styleBlock;
    const req: AgentRunRequest = {
      run_id: `alt-${Date.now()}-${tone.label}`,
      workspace_id: opts.wsId ?? undefined,
      ai_resource: {
        key: 'ai_style_alternatives', // non-registered → neutral generic graph
        name: 'AI Alternatives',
        system_prompt: system,
        provider: opts.resource.llm_provider,
        model: opts.resource.llm_model,
        temperature: 0.6,
        tools: [],
        confidence_threshold: 0.5,
      },
      activity: { id: `alt-${Date.now()}`, channel: opts.activity?.channel ?? 'manual', subject: opts.activity?.subject ?? '', body, priority: 'normal', customer: null },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
    };
    try {
      const resp = await runAgent(req);
      const content = String(resp.draft?.content ?? '').trim();
      return content.length > 5 ? { label: tone.label, content } : null;
    } catch {
      return null;
    }
  };

  const results = await Promise.all(ALT_TONES.map(oneTone));
  return results.filter((r): r is { label: string; content: string } => r !== null);
}

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
    include: { customer: true, project: true, messages: { orderBy: { created_at: 'asc' } }, assigned_resource: true, source: true },
  });
  if (!activity) throw new Error(`activity ${activityId} not found`);
  const wsId = activity.workspace_id; // tenant scope for all writes in this job

  // Support-mailbox detection (computed up-front: it must exempt support@ from
  // the passive email-watch gate below, and it drives the Topic Mission spawn).
  const meta0 = (activity.metadata as any) ?? {};
  const toList = ([] as string[])
    .concat(meta0.to ?? [], meta0.cc ?? [])
    .map((a: string) => String(a).toLowerCase());
  const isSupportEmail = activity.channel === 'email' && toList.some((a) => SUPPORT_MAILBOXES.includes(a));

  // ── 0. Passive email watch — if owner is not a direct To recipient, park it ─
  // Support-mailbox mail is exempt: support@ is intentionally a shared inbox the
  // AI owns end-to-end (→ Topic Mission), so it must NOT be parked as "watching".
  // Coverage-watchdog follow-up activities are also exempt: their `to` is the
  // CUSTOMER (never the owner) by design — parking them would kill the nudge.
  if (
    process.env.EMAIL_WATCH_ENABLED !== 'false' &&
    activity.channel === 'email' &&
    !meta0.coverage &&
    !(ENABLE_TOPIC_MISSIONS && isSupportEmail)
  ) {
    const owner = (process.env.WATCH_OWNER_EMAIL ?? 'deniz@dynamicsops.com').toLowerCase();
    const to: string[] = ((activity.metadata as any)?.to ?? []).map((x: string) => x.toLowerCase());
    // Only apply watch logic when we actually have recipient data; if to is empty, treat as direct (safe default)
    if (to.length > 0) {
      const directToOwner = to.includes(owner);
      if (!directToOwner) {
        await prisma.activities.update({
          where: { id: activityId },
          data: {
            status: 'watching',
            metadata: {
              ...(activity.metadata as any),
              watch: { active: true, reason: 'not direct to owner', since: new Date().toISOString() },
            },
          },
        });
        await audit({
          workspaceId: wsId,
          action: 'route',
          entityType: 'activities',
          entityId: activityId,
          activityId,
          summary: 'Passive watch — not addressed directly to owner; awaiting team reply',
        });
        return;
      }
    }
  }

  // ── 0b. Reply settings for this account (Kurulum) ──────────────────────────
  // Resolve the per-account reply settings (its integration), else the global
  // default row. Wrapped in try/catch — the table may be empty / pre-migration.
  let rs: any = null;
  try {
    const integrationId = (activity as any).source?.integration_id ?? null;
    rs = await (prisma as any).reply_settings.findFirst({ where: { workspace_id: wsId, integration_id: integrationId } });
    if (!rs) rs = await (prisma as any).reply_settings.findFirst({ where: { workspace_id: wsId, integration_id: null } });
  } catch (_) { /* reply_settings table may not exist before first migration */ }

  // Auto-reply toggle: if this account is set to NOT auto-reply, park it (like
  // the passive email-watch branch) and return before any agent run / draft.
  if (rs && rs.auto_reply_enabled === false) {
    await prisma.activities.update({
      where: { id: activityId },
      data: {
        status: 'watching',
        metadata: { ...(activity.metadata as any), reply_disabled: true },
      },
    });
    await audit({
      workspaceId: wsId,
      action: 'route',
      entityType: 'activities',
      entityId: activityId,
      activityId,
      summary: 'Auto-reply disabled for this account (Kurulum) — parked without a draft',
    });
    return;
  }

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

  // Persona routing (Kurulum): if this account pins a specific AI resource to
  // draft its replies, override the routed resource before we load it.
  if (rs?.resource_key) {
    try {
      const persona = await prisma.ai_resources.findUnique({ where: { key: rs.resource_key } });
      if (persona) resourceId = persona.id;
    } catch (_) { /* best-effort persona override */ }
  }

  const resource = await prisma.ai_resources.findUnique({ where: { id: resourceId } });
  if (!resource) throw new Error(`ai_resource ${resourceId} not found`);

  // ── 1b. Topic Mission auto-spawn (ADO work item / support@ email) ──────────
  // Every Azure DevOps activity and every support-mailbox email becomes a Mission
  // Pod (plan → specialists → synthesis). Mission specialist/synthesis activities
  // are channel:'mission' with metadata.mission=true → excluded (no recursion).
  // (meta0 / isSupportEmail are computed up-front, before the email-watch gate.)
  const missionEligible =
    ENABLE_TOPIC_MISSIONS &&
    !meta0.mission &&
    !meta0.mission_spawned &&
    (activity.channel === 'devops' || isSupportEmail);
  if (missionEligible && resourceId) {
    // external_id may be rev-suffixed ('ado:123:r4') under update re-ingestion —
    // the bare work-item id is the mission identity.
    const adoId = activity.channel === 'devops'
      ? String((meta0.ado as any)?.id ?? String(activity.external_id ?? '').replace(/^ado:/, '').split(':')[0])
      : null;

    // Mission dedupe per ADO work item: an update to a ticket that already has
    // a live mission becomes follow-up context on that mission, not a second
    // pod. (A DONE mission + a genuinely new revision → new mission = reopen.)
    if (adoId) {
      // Active-mission counts are small — filter the Json pointer in JS rather
      // than relying on Prisma Json path syntax.
      const candidates = await (prisma as any).missions.findMany({
        where: { workspace_id: wsId, status: { in: ['planning', 'running', 'blocked'] } },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: { id: true, summary: true },
      });
      const existing = candidates.find((m: any) => (m.summary as any)?.parent?.ado_id === adoId) ?? null;
      if (existing) {
        await (prisma as any).agent_messages.create({
          data: {
            workspace_id: wsId,
            mission_id: existing.id,
            kind: 'status',
            body: `ADO update${(meta0.ado as any)?.rev != null ? ` r${(meta0.ado as any).rev}` : ''}: ${activity.subject ?? ''}\n${String(activity.body ?? '').slice(0, 2000)}`,
          },
        });
        await prisma.activities.update({
          where: { id: activityId },
          data: { status: 'completed', completed_at: new Date(), metadata: { ...meta0, mission_id: existing.id, mission_followup: true } },
        });
        await audit({
          workspaceId: wsId,
          action: 'route',
          entityType: 'missions',
          entityId: existing.id,
          activityId,
          summary: `ADO update attached to existing mission (dedupe #${adoId})`,
        });
        return;
      }
    }

    const mission = await (prisma as any).missions.create({
      data: {
        workspace_id: wsId,
        title: (activity.subject ?? 'Untitled topic').slice(0, 240),
        goal: activity.body ?? activity.subject ?? '',
        status: 'planning',
        lead_resource_id: resourceId,
        project_id: activity.project_id ?? null,
        summary: {
          parent: {
            activity_id: activity.id,
            channel: activity.channel,
            conversation_id: meta0.conversation_id ?? null,
            ado_id: adoId,
            from: meta0.from ?? null,
            subject: activity.subject ?? null,
          },
          ado: (meta0.ado as any) ?? null,
        },
      },
    });
    await prisma.activities.update({
      where: { id: activityId },
      data: { status: 'in_progress', metadata: { ...meta0, mission_spawned: true, mission_id: mission.id } },
    });
    await audit({
      workspaceId: wsId,
      action: 'route',
      entityType: 'missions',
      entityId: mission.id,
      activityId,
      summary: `Auto-spawned mission for ${activity.channel} topic`,
    });
    await planAndStartMission(mission.id);
    return; // skip the single-resource draft; the mission drives resolution
  }

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

  // ── 2c. Fetch recent per-resource memories and inject into rag_hits ────────
  const memoryHits: { chunk_id: string; title: string; score: number; text: string }[] = [];
  try {
    // Tenant scope: the worker uses a raw PrismaClient (no tenant-guard), so we
    // MUST filter by workspace_id here — the same resource key handling activities
    // in different workspaces would otherwise mix memories across tenants.
    // resource_id null = workspace-wide Memory Vault entries (shared by all).
    const memFilter: any = {
      workspace_id: wsId,
      AND: [{ OR: [{ resource_id: resource.id }, { resource_id: null }] }],
    };
    if (activity.customer_id) {
      memFilter.AND.push({ OR: [{ customer_id: activity.customer_id }, { customer_id: null }] });
    }
    const memories = await (prisma as any).resource_memories.findMany({
      where: memFilter,
      orderBy: { created_at: 'desc' },
      take: 5,
    });
    for (const mem of memories) {
      memoryHits.push({ chunk_id: `memory:${mem.id}`, title: 'Memory', score: 1, text: mem.content });
    }
  } catch (_) { /* table may not exist yet before first migration */ }

  // ── 2c-bis. Learned reply STYLE: profile (→ system prompt) + topic examples ──
  // Applies the owner's distilled voice + the most relevant past replies for this
  // channel/topic so AI drafts sound like the owner. Worker uses a raw client →
  // filter by workspace_id explicitly (tenant safety).
  let styleProfileText = '';
  const styleHits: { chunk_id: string; title: string; score: number; text: string }[] = [];
  try {
    const prof = await (prisma as any).style_profiles.findFirst({
      where: { workspace_id: wsId, channel: 'all' },
    });
    if (prof?.profile_text) styleProfileText = prof.profile_text;

    // Channel-matched examples, ranked by keyword overlap with this activity.
    const channelKey = activity.channel === 'devops' ? 'devops' : activity.channel === 'teams' ? 'teams' : 'email';
    const examples = await (prisma as any).style_examples.findMany({
      where: { workspace_id: wsId, channel: channelKey },
      orderBy: { sent_at: 'desc' },
      take: 60,
      select: { subject: true, reply_text: true, keywords: true },
    });
    if (examples.length) {
      const hay = `${activity.subject ?? ''} ${activity.body ?? ''}`.toLowerCase();
      const scored = examples.map((e: any) => {
        const kws: string[] = Array.isArray(e.keywords) ? e.keywords : [];
        const overlap = kws.reduce((n, k) => (k && hay.includes(String(k).toLowerCase()) ? n + 1 : n), 0);
        return { e, overlap };
      });
      scored.sort((a: any, b: any) => b.overlap - a.overlap);
      for (const { e } of scored.slice(0, 3)) {
        styleHits.push({
          chunk_id: `style:${(e.subject ?? '').slice(0, 20)}`,
          title: 'STYLE EXAMPLE (owner voice)',
          score: 1,
          text: `Konu: ${e.subject ?? ''}\nGeçmiş yanıt (sahibin stili):\n${String(e.reply_text).slice(0, 800)}`,
        });
      }
    }
  } catch (_) { /* style tables may not exist before first migration */ }

  // ── 2b. Skills composition (P4b) ──────────────────────────────────────────
  // Read attached skill keys from resource.config.skills; fetch active skill rows;
  // append prompt_fragments and union tools into the request (safe, deduped).
  let composedSystemPrompt = resource.system_prompt;
  let composedTools: string[] = (resource.allowed_tools as string[]) ?? [];
  try {
    const attachedSkillKeys: string[] = Array.isArray((resource.config as any)?.skills)
      ? (resource.config as any).skills
      : [];
    if (attachedSkillKeys.length > 0) {
      const skills = await (prisma as any).skills.findMany({
        where: { key: { in: attachedSkillKeys }, is_active: true },
      });
      const fragmentParts: string[] = [];
      for (const skill of skills) {
        if (skill.prompt_fragment) fragmentParts.push(skill.prompt_fragment);
        const skillTools: string[] = Array.isArray(skill.tools) ? skill.tools : [];
        for (const t of skillTools) {
          if (isKnownTool(t) && !composedTools.includes(t)) {
            composedTools = [...composedTools, t];
          }
        }
      }
      if (fragmentParts.length > 0) {
        composedSystemPrompt = composedSystemPrompt + '\n\n## ATTACHED SKILLS\n' + fragmentParts.join('\n\n');
      }
    }
  } catch (_) { /* skills table may not exist before first migration */ }

  // Inject the learned reply-style guide so drafts match the owner's voice.
  if (styleProfileText) {
    composedSystemPrompt = composedSystemPrompt +
      '\n\n## YANIT STİLİ (firma sahibinin öğrenilmiş stili — yanıtı bu sesle yaz)\n' + styleProfileText;
  }

  // ── 2d. Always-on workspace rules (ECC-style standards layer) ─────────────
  // Unlike skills (opt-in per resource), rules apply to EVERY run in scope.
  try {
    const rules = await (prisma as any).workspace_rules.findMany({
      where: { workspace_id: wsId, is_active: true, scope: { in: ['workspace', resource.key] } },
      orderBy: { sort: 'asc' },
      take: 20,
    });
    if (rules.length) {
      composedSystemPrompt +=
        '\n\n## STANDING RULES (always apply — non-negotiable)\n' +
        rules.map((r: any) => `- ${r.title}: ${String(r.body).slice(0, 500)}`).join('\n');
    }
  } catch (_) { /* table may not exist before first push */ }

  // ── 2e. Learned instincts (confidence-scored lessons from human feedback) ─
  // High-confidence instincts whose trigger keywords match this activity are
  // injected; their ids are recorded on the run so approval outcomes can feed
  // confidence back (+applied&approved / −rejected).
  let appliedInstinctIds: string[] = [];
  try {
    const candidates = await (prisma as any).instincts.findMany({
      where: {
        workspace_id: wsId, status: 'active', confidence: { gte: 0.6 },
        OR: [{ resource_id: resource.id }, { resource_id: null }],
      },
      orderBy: { confidence: 'desc' },
      take: 30,
    });
    const hay = `${activity.subject ?? ''} ${activity.body ?? ''}`.toLowerCase();
    const matched = candidates
      .filter((i: any) => String(i.trigger).toLowerCase().split(/[,;|]+/).some((t: string) => t.trim().length > 2 && hay.includes(t.trim())))
      .slice(0, 5);
    if (matched.length) {
      composedSystemPrompt +=
        '\n\n## LEARNED INSTINCTS (geçmiş insan geri bildirimlerinden — uygula)\n' +
        matched.map((i: any) => `- ${i.lesson} (conf ${Number(i.confidence).toFixed(2)})`).join('\n');
      appliedInstinctIds = matched.map((i: any) => i.id);
      await (prisma as any).instincts.updateMany({ where: { id: { in: appliedInstinctIds } }, data: { last_applied_at: new Date() } });
      await prisma.agent_runs.update({
        where: { id: run.id },
        data: { input: { ...((run.input as any) ?? {}), instincts: appliedInstinctIds } as any },
      });
    }
  } catch (_) { /* table may not exist before first push */ }

  const req: AgentRunRequest = {
    run_id: run.id,
    workspace_id: wsId ?? undefined,
    ai_resource: {
      key: resource.key,
      name: resource.name,
      system_prompt: composedSystemPrompt,
      provider: resource.llm_provider,
      model: resource.llm_model,
      temperature: Number(resource.temperature),
      tools: composedTools,
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
      rag_hits: [
        ...styleHits,
        ...memoryHits,
        ...templates.map((t: any) => ({ chunk_id: `template:${t.id}`, document_id: t.id, title: `Template: ${t.name}`, score: 1, text: t.content })),
      ],
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

  // ── 3b. Peer-review gate (2a) ──────────────────────────────────────────
  let peerReviewForcedApproval = false;
  const reviewerKey = (resource.config as any)?.reviewer_key as string | undefined;
  if (reviewerKey && resp.draft?.content) {
    try {
      const reviewerResource = await prisma.ai_resources.findUnique({ where: { key: reviewerKey } });
      if (reviewerResource) {
        const draftContent = resp.draft.content;
        const reviewSubject = `[Review] ${activity.subject ?? '(no subject)'}`;
        const reviewBody = `REVIEW THE FOLLOWING DRAFT produced by ${resource.name} (${resource.role}). Respond with: verdict (approve|revise), 2-4 short comments, and a quality score 0.0-1.0.\n\nSUBJECT: ${activity.subject ?? '(no subject)'}\n\nDRAFT:\n${draftContent}`;
        const reviewReq: AgentRunRequest = {
          run_id: `review-${run.id}`,
          workspace_id: wsId ?? undefined,
          ai_resource: {
            key: reviewerResource.key,
            name: reviewerResource.name,
            system_prompt: reviewerResource.system_prompt,
            provider: reviewerResource.llm_provider,
            model: reviewerResource.llm_model,
            temperature: Number(reviewerResource.temperature),
            tools: [],
            confidence_threshold: Number(reviewerResource.confidence_threshold),
          },
          activity: {
            id: activity.id,
            channel: activity.channel,
            subject: reviewSubject,
            body: reviewBody,
            priority: activity.priority,
            customer: activity.customer ? { id: activity.customer.id, name: activity.customer.name, tier: activity.customer.tier } : null,
            project: null,
            received_at: activity.received_at?.toISOString(),
          },
          context: { thread: [], rag_hints: [], rag_hits: [] },
          options: { max_tool_intents: 0 },
        };
        const reviewResp = await runAgent(reviewReq);
        const reviewText = `${reviewResp.reasoning_summary ?? ''} ${reviewResp.draft?.content ?? ''}`.toLowerCase();
        const verdict = reviewText.includes('revise') ? 'revise' : 'approve';
        const score = reviewResp.confidence ?? 0.8;
        const comments = (reviewResp.draft?.content ?? '').trim().slice(0, 600);
        // Merge review into the original agent_run output
        const existingOutput = (run as any).output ?? resp;
        await prisma.agent_runs.update({
          where: { id: run.id },
          data: {
            output: {
              ...(existingOutput as any),
              review: {
                reviewer_key: reviewerKey,
                reviewer_name: reviewerResource.name,
                verdict,
                score,
                comments,
              },
            } as any,
          },
        });
        if (verdict === 'revise') {
          peerReviewForcedApproval = true;
        }
      }
    } catch (e) {
      // Peer review failure is non-fatal; log and continue
      console.warn(`Peer review failed for run ${run.id}:`, (e as Error).message);
    }
  }

  // ── 4. Post-agent gates → tool_calls + approvals ───────────────────────
  let createdApproval = false;
  let seq = 0;
  for (const intent of resp.tool_intents ?? []) {
    const def = isKnownTool(intent.tool) ? TOOL_REGISTRY[intent.tool] : undefined;
    // All sensitivity checks route through isSensitive() — the single seam
    // where per-workspace tool policies (tiered autonomy) plug in.
    const sensitive = def ? isSensitive(intent.tool) : (intent.sensitive ?? false);
    const risk = (def?.risk ?? 'medium') as any;
    const monetary = def?.monetary ?? false;
    const amount = monetary && typeof intent.args?.amount === 'number' ? (intent.args.amount as number) : null;
    const overLimit = amount !== null && approvalLimit !== null && amount > approvalLimit;
    const requiresApproval = sensitive || resp.needs_escalation || confidence < threshold || overLimit;

    // Reply identity (Kurulum): for outbound MESSAGE intents, stamp the account's
    // signature + reply-as name/email onto the intent args before they are saved.
    const MSG = ['send_email', 'send_proposal'];
    if (MSG.includes(intent.tool) && rs) {
      const a: any = intent.args ?? {};
      if (rs.signature) { const bodyKey = a.body != null ? 'body' : 'content'; a[bodyKey] = String(a[bodyKey] ?? '') + '\n\n' + rs.signature; }
      if (rs.reply_as_name) a.from_name = rs.reply_as_name;
      if (rs.reply_as_email) a.from_email = rs.reply_as_email;
      intent.args = a;
    }

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
      // Coverage autosend: watchdog follow-up drafts auto-send if not reviewed
      // within the SLA timeout (quiet-hours-adjusted; sweeper re-checks the
      // thread for human replies before executing).
      const coverageAutosend =
        MESSAGE_ACTIONS.has(intent.tool) &&
        Boolean(meta0.coverage_autosend) &&
        process.env.ENABLE_COVERAGE_AUTOSEND === 'true';
      const autosendAt = coverageAutosend
        ? new Date(Date.now() + Number(process.env.COVERAGE_AUTOSEND_TIMEOUT_H ?? 4) * 3_600_000)
        : null;
      const createdAppr = await prisma.approvals.create({
        data: {
          workspace_id: wsId,
          activity_id: activityId,
          agent_run_id: run.id,
          tool_call_id: toolCall.id,
          action: intent.tool,
          payload: {
            ...((intent.args ?? {}) as any),
            reply_as: { name: rs?.reply_as_name ?? null, email: rs?.reply_as_email ?? null },
            recipient: (intent.args as any)?.to ?? null,
          } as any,
          risk_level: risk,
          amount: amount ?? undefined,
          reason: resp.needs_escalation ? 'escalation' : confidence < threshold ? 'low_confidence' : 'sensitive_action',
          status: 'pending',
          ...(autosendAt
            ? {
                auto_execute_at: autosendAt,
                auto_policy: { source: 'coverage_watchdog', thread_id: meta0.coverage_thread_id ?? null, policy: 'auto_approve_on_timeout' },
              }
            : {}),
        } as any,
      });

      // Prepare ≥3 toned alternative replies (owner style) for message actions.
      if (MESSAGE_ACTIONS.has(intent.tool)) {
        const primaryDraft = String((intent.args as any)?.content ?? (intent.args as any)?.body ?? resp.draft?.content ?? '');
        if (primaryDraft) {
          try {
            const alternatives = await generateAlternatives({ wsId, resource, styleProfileText, activity, primaryDraft });
            if (alternatives.length) {
              await prisma.approvals.update({
                where: { id: createdAppr.id },
                data: {
                  payload: {
                    ...(intent.args as any),
                    reply_as: { name: rs?.reply_as_name ?? null, email: rs?.reply_as_email ?? null },
                    recipient: (intent.args as any)?.to ?? null,
                    alternatives,
                  } as any,
                },
              });
            }
          } catch (e) {
            console.warn(`Alternatives generation failed for approval ${createdAppr.id}:`, (e as Error).message);
          }
        }
      }
      await notify({
        workspaceId: wsId,
        type: autosendAt ? 'autosend_pending' : 'approval_created',
        title: autosendAt ? `Otomatik gönderim planlandı: ${intent.tool}` : `Approval required: ${intent.tool}`,
        message: autosendAt
          ? `${resource.name} taslağı ${autosendAt.toISOString()} itibarıyla otomatik gönderilecek — öncesinde onayla/reddet.`
          : `${resource.name} proposed ${intent.tool} for "${activity.subject ?? 'activity'}".`,
        metadata: { activityId, agentRunId: run.id, toolCallId: toolCall.id, action: intent.tool, autoExecuteAt: autosendAt?.toISOString() ?? null },
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

  // If peer review verdict was 'revise' and no approval was already created, force one
  if (peerReviewForcedApproval && !createdApproval) {
    createdApproval = true;
    await prisma.approvals.create({
      data: {
        workspace_id: wsId,
        activity_id: activityId,
        agent_run_id: run.id,
        action: 'peer_review_revise',
        payload: {} as any,
        risk_level: 'medium',
        reason: 'peer_review_revise',
        status: 'pending',
      },
    });
    await notify({
      workspaceId: wsId,
      type: 'approval_created',
      title: 'Peer review: revision recommended',
      message: `Reviewer flagged draft by ${resource.name} for "${activity.subject ?? 'activity'}" — please review.`,
      metadata: { activityId, agentRunId: run.id },
    });
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
