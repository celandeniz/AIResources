import { PrismaClient } from '@dynops/db';
import { isSensitive } from '@dynops/shared';
import { Queue } from 'bullmq';
import { executeToolCallViaApi } from './agent-client';
import { selectTemplate } from './mission-templates';

const prisma = new PrismaClient();
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const activityQueue = new Queue('activity.process', { connection: { url } as any });

// Provider label stamped on synthetic (non-LLM) agent_runs created for
// write-back chains — a single seam for cost/free accounting.
const SYNTHETIC_RUN_PROVIDER = { provider: 'nvidia', model: 'synthetic' } as const;

const STOP = new Set(['the', 'and', 'for', 'with', 'our', 'a', 'an', 'to', 'of', 'in', 'on', 'win', 'launch', 'build', 'create', 'new', 'plan', 'get', 'make', 'into']);
const MAX_WORKERS = 5;

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-zçğıöşü0-9]{3,}/gi) ?? []).filter((t) => !STOP.has(t));
}

// Deterministic, zero-key planner: score active resources against the goal and
// build a fan-out → fan-in task graph (lead scopes → specialists work → lead
// synthesizes). The agent then EXECUTES each task via the normal pipeline.
// ADO-parented missions matching a dev-pod template get a TYPED stage graph
// instead (analyze → design → implement → tests → ci → document → PR → QA),
// with explicit role assignment replacing substring scoring.
export async function planAndStartMission(missionId: string) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  if (!mission) return;
  // Plan Canvas resume: an approved plan re-enters via the same queue with
  // status 'running' — skip planning, just continue the graph.
  if (mission.status === 'running') {
    await executeReadyTasks(missionId);
    return;
  }
  if (mission.status !== 'planning') return;
  // Gated plans wait for human approval (missions/:id/approve-plan).
  if ((mission.summary as any)?.plan_pending) return;
  const wsId = mission.workspace_id;

  const resources = await prisma.ai_resources.findMany({ where: { status: 'active', workspace_id: wsId } });
  if (!resources.length) {
    await (prisma as any).missions.update({ where: { id: missionId }, data: { status: 'failed', summary: { error: 'no active resources' } } });
    return;
  }

  // ── Typed dev-pod template path ────────────────────────────────────────────
  if (process.env.ENABLE_DEV_PODS === 'true') {
    const adoMeta = ((mission.summary as any) ?? {}).ado ?? null;
    const template = selectTemplate(adoMeta);
    if (template) {
      // One active dev mission per repo (AL-Go minutes + branch collisions).
      const activeDev = await (prisma as any).missions.findMany({
        where: { workspace_id: wsId, status: { in: ['running', 'blocked'] }, id: { not: missionId } },
        select: { id: true, summary: true },
        take: 50,
      });
      const repoBusy = activeDev.some((m: any) => (m.summary as any)?.template === template.key);
      if (repoBusy) {
        await (prisma as any).missions.update({
          where: { id: missionId },
          data: { status: 'blocked', summary: { ...((mission.summary as any) ?? {}), template: template.key, blocked_reason: 'another dev pod is active for this template/repo' } },
        });
        return;
      }

      const created = new Map<string, string>(); // stage key → task id
      let seq2 = 0;
      for (const stage of template.stages) {
        let assigneeId: string | null = null;
        if (stage.requiredRole) {
          const r = resources.find((x) => x.key === stage.requiredRole);
          if (!r) {
            // Explicit beats silent substring fallback: a missing required role
            // fails the mission with a clear reason.
            await (prisma as any).missions.update({
              where: { id: missionId },
              data: { status: 'failed', summary: { ...((mission.summary as any) ?? {}), template: template.key, error: `missing required role ${stage.requiredRole}` } },
            });
            return;
          }
          assigneeId = r.id;
        }
        const t = await prisma.tasks.create({
          data: {
            workspace_id: wsId, mission_id: missionId,
            title: stage.title,
            description: `${stage.description ?? stage.title}\n\nGOAL: ${mission.goal}`.slice(0, 8000),
            status: 'open', sequence: seq2++,
            depends_on: stage.dependsOn.map((k) => created.get(k)).filter(Boolean) as string[],
            assignee_resource_id: assigneeId,
            metadata: { mission: true, role: stage.key, kind: stage.kind, stage_config: (stage.config ?? {}) as any, report_progress: Boolean(stage.reportProgress) } as any,
          },
        });
        created.set(stage.key, t.id);
      }

      await (prisma as any).agent_messages.create({
        data: { workspace_id: wsId, mission_id: missionId, kind: 'plan', body: `Dev pod plan (${template.key}): ${template.stages.map((s) => s.title).join(' → ')}.` },
      });

      // Plan Canvas gate: dev-pod plans wait for human approval before running.
      const gated = (process.env.PLAN_GATE_TEMPLATES ?? 'bc_dev,fscm_dev')
        .split(',').map((s) => s.trim()).filter(Boolean).includes(template.key);
      await (prisma as any).missions.update({
        where: { id: missionId },
        data: {
          status: gated ? 'planning' : 'running',
          summary: { ...((mission.summary as any) ?? {}), template: template.key, ...(gated ? { plan_pending: true } : {}) },
        },
      });
      console.log(`[mission] ${mission.title}: dev-pod plan (${template.key}) ${gated ? 'awaits approval (Plan Canvas)' : 'started'}`);
      if (!gated) await executeReadyTasks(missionId);
      return;
    }
  }

  const goalTokens = new Set(tokens(`${mission.title} ${mission.goal}`));
  const scored = resources
    .map((r) => {
      const hay = `${r.key} ${r.role} ${r.name} ${(r.config as any)?.skill ?? ''}`.toLowerCase();
      const score = [...goalTokens].reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score);

  // Lead = explicit, else top-scoring, else the executive assistant / first.
  const lead =
    (mission.lead_resource_id && resources.find((r) => r.id === mission.lead_resource_id)) ||
    resources.find((r) => r.key === 'ai_solution_architect') ||
    scored[0]?.r ||
    resources[0];

  // Specialists = top scorers excluding the lead (fall back to a few generalists).
  let specialists = scored.filter((s) => s.score > 0 && s.r.id !== lead.id).map((s) => s.r).slice(0, MAX_WORKERS);
  if (!specialists.length) {
    specialists = resources.filter((r) => r.id !== lead.id).slice(0, 3);
  }

  // Build tasks: [0] lead scope → [1..n] specialists (dep on 0) → [last] lead synthesis (dep on all specialists).
  const created: { id: string; idx: number }[] = [];
  const scope = await prisma.tasks.create({
    data: {
      workspace_id: wsId, mission_id: missionId, title: `Scope & plan: ${mission.title}`,
      description: `Break down the goal and align the team.\n\nGOAL: ${mission.goal}`,
      status: 'open', sequence: 0, depends_on: [], assignee_resource_id: lead.id,
      metadata: { mission: true, role: 'lead-scope' },
    },
  });
  created.push({ id: scope.id, idx: 0 });

  const specIds: string[] = [];
  let seq = 1;
  for (const sp of specialists) {
    const t = await prisma.tasks.create({
      data: {
        workspace_id: wsId, mission_id: missionId,
        title: `${sp.name}: contribute to "${mission.title}"`,
        description: `As ${sp.role}, deliver your part toward the mission goal and hand off as needed.\n\nGOAL: ${mission.goal}`,
        status: 'open', sequence: seq++, depends_on: [scope.id], assignee_resource_id: sp.id,
        metadata: { mission: true, role: 'specialist' },
      },
    });
    specIds.push(t.id);
  }

  await prisma.tasks.create({
    data: {
      workspace_id: wsId, mission_id: missionId, title: `Synthesize & deliver: ${mission.title}`,
      description: `Consolidate the team's outputs into the final deliverable and next actions.\n\nGOAL: ${mission.goal}`,
      status: 'open', sequence: seq, depends_on: specIds, assignee_resource_id: lead.id,
      metadata: { mission: true, role: 'lead-synthesis' },
    },
  });

  await (prisma as any).agent_messages.create({
    data: { workspace_id: wsId, mission_id: missionId, from_resource_id: lead.id, kind: 'plan', body: `Plan: 1 scope → ${specIds.length} specialist task(s) → 1 synthesis. Lead: ${lead.name}.` },
  });
  await (prisma as any).missions.update({ where: { id: missionId }, data: { status: 'running', lead_resource_id: lead.id } });
  console.log(`[mission] ${mission.title}: planned ${specIds.length + 2} tasks, lead ${lead.name}`);

  await executeReadyTasks(missionId);
}

// Enqueue every open task whose dependencies are all `done` (auto-unblock).
export async function executeReadyTasks(missionId: string) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  if (!mission || (mission.status !== 'running' && mission.status !== 'blocked')) return;
  const tasks = await prisma.tasks.findMany({ where: { mission_id: missionId } });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ready = tasks.filter((t) => {
    if (t.status !== 'open') return false;
    const deps = (t.depends_on as string[]) ?? [];
    return deps.every((d) => byId.get(d)?.status === 'done');
  });

  // First activity on an ADO-parented mission → progressive 'started' write-back
  // (comment + state 'Active'). Ledger-guarded, so this fires exactly once.
  if (ready.length && (mission.summary as any)?.parent?.channel === 'devops') {
    await emitParentEvent(missionId, {
      kind: 'started',
      text: `🤖 DynOps pod started on "${mission.title}" — ${tasks.length} task(s) planned.`,
      state: 'Active',
    });
  }

  for (const t of ready) {
    const kind = ((t.metadata as any)?.kind ?? 'agent') as string;
    if (kind !== 'agent') {
      // System stage (code/ci/pr) — deterministic executor, no LLM proposal.
      const { runSystemStage } = await import('./mission-stages');
      runSystemStage(missionId, t.id).catch((e) =>
        console.error(`[mission] system stage "${t.title}" failed:`, (e as Error).message),
      );
      console.log(`[mission] ${mission.title}: started system stage "${t.title}" (${kind})`);
      continue;
    }
    const resource = t.assignee_resource_id ? await prisma.ai_resources.findUnique({ where: { id: t.assignee_resource_id } }) : null;
    const activity = await prisma.activities.create({
      data: {
        workspace_id: mission.workspace_id,
        channel: 'mission',
        subject: `[Mission] ${t.title}`,
        body: `${t.description}\n\nYou are part of mission "${mission.title}". Produce your deliverable, create tasks for concrete actions, post_message a brief status to the mission, and handoff to teammates if needed.`,
        status: 'new',
        assigned_resource_id: t.assignee_resource_id,
        project_id: mission.project_id ?? null,
        metadata: { mission: true, mission_id: missionId, task_id: t.id, handoff_depth: 0 },
      },
    });
    await prisma.tasks.update({ where: { id: t.id }, data: { status: 'in_progress', metadata: { ...(t.metadata as any), activity_id: activity.id } } });
    await activityQueue.add('process', { activityId: activity.id }, { removeOnComplete: 1000, removeOnFail: 1000 });
    console.log(`[mission] ${mission.title}: started task "${t.title}"${resource ? ` (${resource.name})` : ''}`);
  }

  // If nothing ready and nothing in flight, the mission is complete (or stuck).
  const fresh = await prisma.tasks.findMany({ where: { mission_id: missionId } });
  const open = fresh.filter((t) => t.status === 'open' || t.status === 'in_progress');
  if (!open.length) {
    const done = fresh.filter((t) => t.status === 'done').length;
    // Atomic done-transition: the worker runs at concurrency 5, so two
    // executeReadyTasks calls can interleave when the last tasks finish together.
    // A conditional updateMany (status != 'done') lets exactly ONE call flip the
    // mission and own the single write-back; the losers see count 0 and no-op.
    const flipped = await (prisma as any).missions.updateMany({
      where: { id: missionId, status: { not: 'done' } },
      data: { status: 'done', summary: { ...((mission.summary as any) ?? {}), tasks: fresh.length, done, completedAt: new Date().toISOString() } },
    });
    if (flipped.count === 1) {
      console.log(`[mission] ${mission.title}: DONE (${done}/${fresh.length} tasks)`);
      const synthesis = await findSynthesis(missionId);
      await emitParentEvent(missionId, { kind: 'synthesis', text: synthesis, state: 'Resolved' }).catch((e) =>
        console.warn(`[mission] write-back failed for ${missionId}:`, (e as Error).message),
      );
    }
  } else if (!ready.length && !open.some((t) => t.status === 'in_progress')) {
    // All remaining are open but blocked with no in-flight work → blocked.
    await (prisma as any).missions.update({ where: { id: missionId }, data: { status: 'blocked' } });
  }
}

// ── Progressive parent write-back ─────────────────────────────────────────────
// Every notable mission event (started / milestone task done / CI failure / PR
// opened / final synthesis) is written back to the originating ADO work item or
// support thread. Non-sensitive actions (devops_comment, devops_set_state —
// per isSensitive) execute immediately; sensitive ones (send_email) go through
// the approval gate. Idempotent via the summary.parent.write_backs ledger
// (legacy boolean written_back === ledger containing 'synthesis').
// RAW prisma client (no tenant guard) → stamp workspace_id on every create.
// Never throws — must not break mission progression.

export type ParentEventKind = 'started' | 'task_done' | 'progress' | 'synthesis' | 'pr_opened' | 'ci_failed';
export interface ParentEvent {
  kind: ParentEventKind;
  text: string;
  state?: string; // optional ADO state transition (whitelisted in the adapter)
  ref?: string; // idempotency discriminator for repeatable kinds (task id, attempt #)
}

// Find the synthesis deliverable (lead-synthesis task's latest outbound draft,
// falling back to any outbound message across the mission's task activities).
export async function findSynthesis(missionId: string): Promise<string> {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  const tasks = await prisma.tasks.findMany({ where: { mission_id: missionId } });
  const synthTask = tasks.find((t) => ['lead-synthesis', 'synthesis'].includes((t.metadata as any)?.role));
  let synthesis = '';
  const synthActivityId = (synthTask?.metadata as any)?.activity_id as string | undefined;
  if (synthActivityId) {
    const msg = await prisma.messages.findFirst({
      where: { activity_id: synthActivityId, direction: 'outbound' },
      orderBy: { created_at: 'desc' },
    });
    if (msg?.body) synthesis = msg.body;
  }
  if (!synthesis) {
    const actIds = tasks
      .map((t) => (t.metadata as any)?.activity_id as string | undefined)
      .filter((x): x is string => Boolean(x));
    if (actIds.length) {
      const msg = await prisma.messages.findFirst({
        where: { activity_id: { in: actIds }, direction: 'outbound' },
        orderBy: { created_at: 'desc' },
      });
      if (msg?.body) synthesis = msg.body;
    }
  }
  return (synthesis || mission?.title || '').slice(0, 6000);
}

export async function emitParentEvent(missionId: string, ev: ParentEvent) {
  try {
    const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
    if (!mission) return;
    const summary = (mission.summary as any) ?? {};
    const parent = summary.parent;
    if (!parent) return;

    // Ledger + legacy-boolean idempotency.
    const ledger: { kind: string; ref?: string; at: string }[] = Array.isArray(parent.write_backs)
      ? parent.write_backs
      : parent.written_back === true
        ? [{ kind: 'synthesis', at: new Date(0).toISOString() }]
        : [];
    if (ledger.some((e) => e.kind === ev.kind && (e.ref ?? null) === (ev.ref ?? null))) return;

    const wsId = mission.workspace_id;

    // Build the actions: ADO parents get comments (+ optional state); email
    // parents only receive the final synthesis (progressive events are ADO-only).
    const actions: { action: string; args: Record<string, any>; risk: string }[] = [];
    if (parent.channel === 'devops' && parent.ado_id) {
      actions.push({ action: 'devops_comment', args: { workItemId: parent.ado_id, text: ev.text }, risk: 'low' });
      if (ev.state) actions.push({ action: 'devops_set_state', args: { workItemId: parent.ado_id, state: ev.state }, risk: 'low' });
    } else if (ev.kind === 'synthesis') {
      actions.push({
        action: 'send_email',
        args: { to: [parent.from].filter(Boolean), subject: `Re: ${parent.subject ?? mission.title}`, body: ev.text },
        risk: 'medium',
      });
    } else {
      return; // non-ADO parent + non-synthesis event → nothing to write back
    }

    // Resolve a resource for the agent_run FK (ai_resource_id is required).
    let resourceId: string | null = mission.lead_resource_id ?? null;
    if (!resourceId) {
      const anyResource = await prisma.ai_resources.findFirst({ where: { status: 'active', workspace_id: wsId } });
      if (!anyResource) {
        console.warn(`[mission] write-back skipped for ${missionId}: no resource for agent_run`);
        return;
      }
      resourceId = anyResource.id;
    }

    const agentRun = await prisma.agent_runs.create({
      data: {
        workspace_id: wsId,
        activity_id: parent.activity_id,
        ai_resource_id: resourceId,
        llm_provider: SYNTHETIC_RUN_PROVIDER.provider as any,
        llm_model: SYNTHETIC_RUN_PROVIDER.model,
        status: 'succeeded',
        input: { mission_id: missionId, event: ev.kind } as any,
        output: {} as any,
        tools_used: actions.map((a) => a.action) as any,
      },
    });

    let seq = 0;
    for (const { action, args, risk } of actions) {
      const sensitive = isSensitive(action);
      const toolCall = await prisma.tool_calls.create({
        data: {
          workspace_id: wsId,
          agent_run_id: agentRun.id,
          name: action,
          args: args as any,
          requires_approval: sensitive,
          risk_level: risk as any,
          status: sensitive ? 'awaiting_approval' : 'approved',
          sequence: seq++,
        },
      });
      if (sensitive) {
        await prisma.approvals.create({
          data: {
            workspace_id: wsId,
            activity_id: parent.activity_id,
            agent_run_id: agentRun.id,
            tool_call_id: toolCall.id,
            action,
            payload: { ...args, mission_id: missionId } as any,
            risk_level: risk as any,
            reason: `Mission "${mission.title}" — ${ev.kind} (${action})`,
            status: 'pending',
            expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
          },
        });
      } else {
        // Tiered autonomy: internal ADO writes execute immediately.
        await executeToolCallViaApi(toolCall.id).catch((e) =>
          console.warn(`[mission] auto write-back ${action} failed for ${missionId}:`, (e as Error).message),
        );
      }
    }

    ledger.push({ kind: ev.kind, ref: ev.ref, at: new Date().toISOString() });
    await (prisma as any).missions.update({
      where: { id: missionId },
      data: { summary: { ...summary, parent: { ...parent, write_backs: ledger, written_back: ledger.some((e) => e.kind === 'synthesis') } } },
    });
    console.log(`[mission] ${mission.title}: parent event '${ev.kind}' written back (${actions.map((a) => a.action).join('+')})`);
  } catch (e) {
    console.warn(`[mission] emitParentEvent(${missionId}) error:`, (e as Error).message);
  }
}

// Called by the activity worker after a mission-task activity finishes. Marks the
// task done when its activity reached a terminal non-pending state, then advances.
export async function advanceMissionFromActivity(activityId: string) {
  const activity = await prisma.activities.findUnique({ where: { id: activityId } });
  const meta = (activity?.metadata as any) ?? {};
  if (!activity || !meta.mission_id || !meta.task_id) return;
  // 'awaiting_approval' means a human gate is pending → leave the task in_progress.
  if (!['completed', 'escalated', 'failed'].includes(activity.status)) return;
  const task = await prisma.tasks.findUnique({ where: { id: meta.task_id } });
  if (!task || task.status === 'done') return;
  await prisma.tasks.update({ where: { id: meta.task_id }, data: { status: 'done', completed_at: new Date() } });
  // PR stage completed (auto or via approval) → capture the PR url, link it on
  // the ADO work item, and advance the state to 'Ready for Review'.
  if ((task.metadata as any)?.kind === 'pr') {
    const prCall = await prisma.tool_calls.findFirst({
      where: { name: 'github_create_pr', status: 'succeeded', agent_run: { activity_id: activityId } },
      orderBy: { created_at: 'desc' },
    });
    const prUrl = (prCall?.result as any)?.data?.html_url ?? null;
    if (prUrl) {
      const mission = await (prisma as any).missions.findUnique({ where: { id: meta.mission_id } });
      const summary = (mission?.summary as any) ?? {};
      await (prisma as any).missions.update({
        where: { id: meta.mission_id },
        data: { summary: { ...summary, dev: { ...(summary.dev ?? {}), pr_url: prUrl } } },
      });
      const adoId = summary.parent?.ado_id;
      if (adoId) {
        await emitParentEvent(meta.mission_id, {
          kind: 'pr_opened',
          text: `🔀 Pull request opened: ${prUrl}\nMerge kararı insan onayında.`,
          state: 'Ready for Review',
        });
        // Attach the PR as a hyperlink relation on the work item (auto tool).
        const mission2 = await (prisma as any).missions.findUnique({ where: { id: meta.mission_id } });
        const resourceId = mission2?.lead_resource_id ?? (await prisma.ai_resources.findFirst({ where: { status: 'active', workspace_id: mission2?.workspace_id } }))?.id;
        if (resourceId) {
          const run = await prisma.agent_runs.create({
            data: {
              workspace_id: mission2.workspace_id, activity_id: summary.parent?.activity_id ?? activityId,
              ai_resource_id: resourceId, llm_provider: 'nvidia', llm_model: 'synthetic', status: 'succeeded',
              input: { mission_id: meta.mission_id, event: 'pr_link' } as any, output: {} as any, tools_used: ['devops_link_workitem'] as any,
            },
          });
          const tc = await prisma.tool_calls.create({
            data: {
              workspace_id: mission2.workspace_id, agent_run_id: run.id, name: 'devops_link_workitem',
              args: { workItemId: adoId, url: prUrl, rel: 'Hyperlink', comment: 'Dev pod PR' } as any,
              requires_approval: false, risk_level: 'low', status: 'approved', sequence: 0,
            },
          });
          await executeToolCallViaApi(tc.id).catch((e) => console.warn('[mission] PR link failed:', (e as Error).message));
        }
      }
    }
  }
  // Milestone tasks (metadata.report_progress, set by dev-pod templates) emit a
  // progressive ADO comment as they complete.
  if ((task.metadata as any)?.report_progress) {
    const msg = await prisma.messages.findFirst({
      where: { activity_id: activityId, direction: 'outbound' },
      orderBy: { created_at: 'desc' },
    });
    await emitParentEvent(meta.mission_id, {
      kind: 'task_done',
      ref: task.id,
      text: `✅ ${task.title} completed.${msg?.body ? `\n\n${msg.body.slice(0, 1500)}` : ''}`,
    });
  }
  await executeReadyTasks(meta.mission_id);
}
