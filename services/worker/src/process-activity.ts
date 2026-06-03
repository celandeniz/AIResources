import { PrismaClient } from '@dynops/db';
import { TOOL_REGISTRY, isKnownTool, type AgentRunRequest, type ToolName } from '@dynops/shared';
import { matchRoutingRule, type RuleRow } from './rules';
import { runAgent, executeToolCallViaApi } from './agent-client';

const prisma = new PrismaClient();

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
    include: { customer: true, project: true, messages: { orderBy: { created_at: 'asc' } }, assigned_resource: true },
  });
  if (!activity) throw new Error(`activity ${activityId} not found`);
  const wsId = activity.workspace_id; // tenant scope for all writes in this job

  // ── 0. Passive email watch — if owner is not a direct To recipient, park it ─
  if (
    process.env.EMAIL_WATCH_ENABLED !== 'false' &&
    activity.channel === 'email'
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

  // ── 2c. Fetch recent per-resource memories and inject into rag_hits ────────
  const memoryHits: { chunk_id: string; title: string; score: number; text: string }[] = [];
  try {
    // Tenant scope: the worker uses a raw PrismaClient (no tenant-guard), so we
    // MUST filter by workspace_id here — the same resource key handling activities
    // in different workspaces would otherwise mix memories across tenants.
    const memFilter: any = { resource_id: resource.id, workspace_id: wsId };
    if (activity.customer_id) {
      memFilter.OR = [{ customer_id: activity.customer_id }, { customer_id: null }];
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
      const createdAppr = await prisma.approvals.create({
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

      // Prepare ≥3 toned alternative replies (owner style) for message actions.
      if (MESSAGE_ACTIONS.has(intent.tool)) {
        const primaryDraft = String((intent.args as any)?.content ?? (intent.args as any)?.body ?? resp.draft?.content ?? '');
        if (primaryDraft) {
          try {
            const alternatives = await generateAlternatives({ wsId, resource, styleProfileText, activity, primaryDraft });
            if (alternatives.length) {
              await prisma.approvals.update({
                where: { id: createdAppr.id },
                data: { payload: { ...(intent.args as any), alternatives } as any },
              });
            }
          } catch (e) {
            console.warn(`Alternatives generation failed for approval ${createdAppr.id}:`, (e as Error).message);
          }
        }
      }
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
