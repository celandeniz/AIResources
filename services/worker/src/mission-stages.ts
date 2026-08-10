// Deterministic system-stage executor for dev Mission Pods (code / ci / pr).
// Each stage gets a synthetic mission activity (channel 'mission',
// metadata.mission_id/task_id) so the standard mission.advance machinery works
// uniformly — including approval-gated stages (github_create_pr while it stays
// sensitive). Non-sensitive tools execute immediately (tiered autonomy).
// RAW prisma client → stamp workspace_id on every create.

import { PrismaClient } from '@dynops/db';
import { isSensitive } from '@dynops/shared';
import { Queue } from 'bullmq';
import { executeToolCallViaApi } from './agent-client';
import { emitParentEvent } from './mission';

const prisma = new PrismaClient();
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const CI_POLL_QUEUE = 'mission.ci-poll';
const ciPollQueue = new Queue(CI_POLL_QUEUE, { connection: { url } as any });

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const CODE_STAGE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS ?? 1_800_000) + 120_000;

// ── shared helpers ────────────────────────────────────────────────────────────

async function internalGet(path: string): Promise<any> {
  const res = await fetch(`${API_URL}/api/v1${path}`, { headers: { 'x-internal-token': INTERNAL_TOKEN } });
  if (!res.ok) throw new Error(`internal GET ${path} → ${res.status}`);
  return res.json();
}

function devBranch(mission: any): string {
  const summary = (mission.summary as any) ?? {};
  if (summary.dev?.branch) return summary.dev.branch;
  const adoId = summary.parent?.ado_id ?? 'x';
  return `mission/${String(mission.id).slice(0, 8)}-ado-${adoId}`;
}

async function saveDev(missionId: string, patch: Record<string, unknown>) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  const summary = (mission?.summary as any) ?? {};
  await (prisma as any).missions.update({
    where: { id: missionId },
    data: { summary: { ...summary, dev: { ...(summary.dev ?? {}), ...patch } } },
  });
}

// Latest outbound deliverable of a stage (by its stage key).
async function stageOutput(missionId: string, stageKey: string): Promise<string> {
  const task = await prisma.tasks.findFirst({
    where: { mission_id: missionId, metadata: { path: ['role'], equals: stageKey } as any },
  }).catch(() => null);
  const activityId = (task?.metadata as any)?.activity_id as string | undefined;
  if (!activityId) return '';
  const msg = await prisma.messages.findFirst({
    where: { activity_id: activityId, direction: 'outbound' },
    orderBy: { created_at: 'desc' },
  });
  return msg?.body ?? '';
}

// Synthetic activity so mission.advance semantics apply to system stages too.
async function stageActivity(mission: any, task: any, subject: string) {
  return prisma.activities.create({
    data: {
      workspace_id: mission.workspace_id,
      channel: 'mission',
      subject,
      body: `[system stage] ${task.title}`,
      status: 'in_progress',
      project_id: mission.project_id ?? null,
      metadata: { mission: true, mission_id: mission.id, task_id: task.id, system_stage: true, kind: (task.metadata as any)?.kind },
    },
  });
}

// Synthetic agent_run → tool_call for a system stage. Non-sensitive → status
// 'approved' (auto); sensitive → 'awaiting_approval' + approvals row.
async function stageToolCall(mission: any, activity: any, tool: string, args: Record<string, unknown>, reason: string) {
  const resourceId =
    mission.lead_resource_id ??
    (await prisma.ai_resources.findFirst({ where: { status: 'active', workspace_id: mission.workspace_id } }))?.id;
  if (!resourceId) throw new Error('no active resource for stage agent_run');
  const run = await prisma.agent_runs.create({
    data: {
      workspace_id: mission.workspace_id,
      activity_id: activity.id,
      ai_resource_id: resourceId,
      llm_provider: 'nvidia',
      llm_model: 'synthetic',
      status: 'succeeded',
      input: { mission_id: mission.id, stage: reason } as any,
      output: {} as any,
      tools_used: [tool] as any,
    },
  });
  const sensitive = isSensitive(tool);
  const toolCall = await prisma.tool_calls.create({
    data: {
      workspace_id: mission.workspace_id,
      agent_run_id: run.id,
      name: tool,
      args: args as any,
      requires_approval: sensitive,
      risk_level: 'medium',
      status: sensitive ? 'awaiting_approval' : 'approved',
      sequence: 0,
    },
  });
  if (sensitive) {
    await prisma.approvals.create({
      data: {
        workspace_id: mission.workspace_id,
        activity_id: activity.id,
        agent_run_id: run.id,
        tool_call_id: toolCall.id,
        action: tool,
        payload: { ...args, mission_id: mission.id } as any,
        risk_level: 'medium',
        reason,
        status: 'pending',
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    });
  }
  return { toolCall, sensitive };
}

async function completeStage(mission: any, task: any, activity: any) {
  await prisma.activities.update({ where: { id: activity.id }, data: { status: 'completed', completed_at: new Date() } });
  // advanceMissionFromActivity (mission.ts) marks the task done + continues the
  // graph; the caller triggers it via the activity worker path or directly.
}

async function failStage(mission: any, task: any, activity: any, error: string) {
  await prisma.activities.update({ where: { id: activity.id }, data: { status: 'failed', metadata: { ...((activity.metadata as any) ?? {}), error } } });
  await (prisma as any).missions.update({ where: { id: mission.id }, data: { status: 'blocked' } });
  await (prisma as any).notifications.create({
    data: {
      workspace_id: mission.workspace_id,
      type: 'mission_blocked',
      title: `Dev pod blocked: ${mission.title}`.slice(0, 200),
      message: `Stage "${task.title}" failed: ${error.slice(0, 400)}`,
      metadata: { missionId: mission.id, taskId: task.id },
    },
  });
  await emitParentEvent(mission.id, { kind: 'ci_failed', ref: `stage-${task.id}`, text: `⚠️ DynOps pod blocked at "${task.title}": ${error.slice(0, 500)}` });
}

// ── stage runners ─────────────────────────────────────────────────────────────

export async function runSystemStage(missionId: string, taskId: string) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  const task = await prisma.tasks.findUnique({ where: { id: taskId } });
  if (!mission || !task) return;
  const meta = (task.metadata as any) ?? {};
  const kind = meta.kind as string;
  const cfg = (meta.stage_config as any) ?? {};

  // Idempotent re-entry (worker restart): a stage that already has an activity
  // in a terminal state is not re-run.
  if (meta.activity_id) {
    const prev = await prisma.activities.findUnique({ where: { id: meta.activity_id } });
    if (prev && ['completed', 'failed'].includes(prev.status)) return;
  }

  const activity = await stageActivity(mission, task, `[Stage] ${task.title}`);
  await prisma.tasks.update({ where: { id: taskId }, data: { status: 'in_progress', metadata: { ...meta, activity_id: activity.id } } });

  try {
    if (kind === 'code') await runCodeStage(mission, task, activity, cfg);
    else if (kind === 'ci') await runCiStage(mission, task, activity, cfg, 0);
    else if (kind === 'pr') await runPrStage(mission, task, activity, cfg);
    else throw new Error(`unknown system stage kind: ${kind}`);
  } catch (e) {
    await failStage(mission, task, activity, (e as Error).message);
  }
}

async function runCodeStage(mission: any, task: any, activity: any, cfg: any) {
  const meta = (task.metadata as any) ?? {};
  const branch = devBranch(mission);
  await saveDev(mission.id, { branch });

  // Instruction assembled from prior stage outputs + repo conventions.
  const design = await stageOutput(mission.id, 'design');
  const analysis = await stageOutput(mission.id, 'analyze');
  const parent = ((mission.summary as any) ?? {}).parent ?? {};
  let instruction: string;
  if (cfg.testStage) {
    const docsHint = 'Write AL TEST codeunits for the changes on this branch, under the matching test app folder (apps/DynOpsBC.*.Test/src), following the existing OSDWHSHealthTest/OSDPRDProductionTest conventions and using ids from the test app.json id range. Cover the acceptance criteria below.';
    instruction = `${docsHint}\n\n=== ACCEPTANCE CRITERIA / ANALYSIS ===\n${analysis.slice(0, 3000)}\n\n=== DESIGN ===\n${design.slice(0, 3000)}`;
  } else if (cfg.docsStage) {
    const docText = await stageOutput(mission.id, 'document');
    instruction = `Add the following documentation as a markdown file under docs/changes/ named after the work item (ado-${parent.ado_id ?? 'x'}.md). Commit it to the current branch. Do not modify code.\n\n=== DOCUMENT ===\n${docText.slice(0, 6000)}`;
  } else {
    instruction =
      `Implement the following change in this Business Central AL repository. Follow the repo's naming conventions ` +
      `('OSDPRD <Name>.<Type>.al' / 'OSDWHS <Name>.<Type>.al'), keep object ids inside the app.json idRanges, and keep the change minimal.\n\n` +
      `=== WORK ITEM ===\n[#${parent.ado_id ?? '?'}] ${mission.title}\n\n=== ANALYSIS ===\n${analysis.slice(0, 3000)}\n\n=== DESIGN ===\n${design.slice(0, 4000)}`;
  }

  const codeTask = await (prisma as any).code_tasks.create({
    data: {
      workspace_id: mission.workspace_id,
      title: `${mission.title} — ${task.title}`.slice(0, 300),
      repo: cfg.repoKey ?? cfg.repo ?? null,
      instruction,
      model: process.env.OPENCODE_MODEL ?? null,
      agent: 'build',
      status: 'running',
      mission_id: mission.id,
    },
  });

  const { toolCall } = await stageToolCall(mission, activity, 'code_task', {
    instruction,
    repo: cfg.repoKey ?? cfg.repo,
    branch,
    code_task_id: codeTask.id,
    mission_id: mission.id,
  }, `Dev pod stage: ${task.title}`);

  // Fire the execution; the API keeps processing even if this HTTP call times
  // out client-side — we then poll the code_tasks row for the outcome.
  executeToolCallViaApi(toolCall.id).catch(() => { /* outcome read from DB below */ });

  const deadline = Date.now() + CODE_STAGE_TIMEOUT_MS;
  let finalStatus = 'running';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const fresh = await (prisma as any).code_tasks.findUnique({ where: { id: codeTask.id }, select: { status: true, result: true } });
    if (fresh && ['done', 'failed'].includes(fresh.status)) {
      finalStatus = fresh.status;
      break;
    }
  }
  if (finalStatus !== 'done') throw new Error(`code stage ${finalStatus === 'running' ? 'timed out' : 'failed'} (code_task ${codeTask.id})`);

  // Verify the branch actually exists before advancing (skip in mock mode).
  const fresh = await (prisma as any).code_tasks.findUnique({ where: { id: codeTask.id }, select: { result: true } });
  const mock = Boolean((fresh?.result as any)?.mock);
  if (!mock && cfg.repo) {
    try {
      const ci = await internalGet(`/internal/github/ci-status?repo=${encodeURIComponent(cfg.repo)}&branch=${encodeURIComponent(branch)}`);
      if (ci?.configured && !ci?.branch?.exists) {
        throw new Error(`OpenCode reported success but branch '${branch}' was not pushed`);
      }
    } catch (e) {
      if ((e as Error).message.includes('was not pushed')) throw e;
      // internal endpoint unreachable → non-fatal
    }
  }

  await completeStage(mission, task, activity);
  const { advanceMissionFromActivity } = await import('./mission');
  await advanceMissionFromActivity(activity.id);
}

export async function runCiStage(mission: any, task: any, activity: any, cfg: any, attempt: number) {
  const branch = devBranch(mission);
  const repo = cfg.repo as string;

  // GitHub unconfigured → mock-pass so the pod can be exercised end-to-end.
  let configured = true;
  try {
    const ci = await internalGet(`/internal/github/ci-status?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);
    configured = Boolean(ci?.configured);
  } catch {
    configured = false;
  }
  if (!configured) {
    console.log(`[mission-stage] ci: GitHub not configured — mock pass for ${mission.title}`);
    await completeStage(mission, task, activity);
    const { advanceMissionFromActivity } = await import('./mission');
    await advanceMissionFromActivity(activity.id);
    return;
  }

  const { toolCall } = await stageToolCall(mission, activity, 'github_dispatch_workflow', {
    repo,
    workflow: cfg.workflow ?? 'CICD.yaml',
    ref: branch,
  }, `Dev pod CI: ${task.title} (attempt ${attempt + 1})`);
  await executeToolCallViaApi(toolCall.id);

  await ciPollQueue.add(
    'poll',
    { missionId: mission.id, taskId: task.id, activityId: activity.id, repo, workflow: cfg.workflow ?? 'CICD.yaml', branch, attempt, maxRepairAttempts: Number(cfg.maxRepairAttempts ?? 2), dispatchedAt: Date.now() },
    { delay: 90_000, removeOnComplete: 500, removeOnFail: 500 },
  );
}

// Consumed by the mission.ci-poll worker in index.ts.
export async function pollCiRun(job: {
  missionId: string; taskId: string; activityId: string; repo: string; workflow: string; branch: string;
  attempt: number; maxRepairAttempts: number; dispatchedAt: number;
}) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: job.missionId } });
  const task = await prisma.tasks.findUnique({ where: { id: job.taskId } });
  const activity = await prisma.activities.findUnique({ where: { id: job.activityId } });
  if (!mission || !task || !activity) return;

  let ci: any = null;
  try {
    ci = await internalGet(`/internal/github/ci-status?repo=${encodeURIComponent(job.repo)}&branch=${encodeURIComponent(job.branch)}&workflow=${encodeURIComponent(job.workflow)}`);
  } catch {
    /* transient */
  }
  const run = ci?.run;
  const running = !run || run.status !== 'completed';
  const timedOut = Date.now() - job.dispatchedAt > 90 * 60_000;

  if (running && !timedOut) {
    await ciPollQueue.add('poll', job, { delay: 60_000, removeOnComplete: 500, removeOnFail: 500 });
    return;
  }
  if (running && timedOut) {
    await failStage(mission, task, activity, `CI run did not complete within 90 min (${job.workflow}@${job.branch})`);
    return;
  }

  if (run.conclusion === 'success') {
    await completeStage(mission, task, activity);
    const { advanceMissionFromActivity } = await import('./mission');
    await advanceMissionFromActivity(activity.id);
    return;
  }

  // Failure → bounded repair loop: a repair code_task on the same branch, then re-dispatch.
  if (job.attempt >= job.maxRepairAttempts) {
    await failStage(mission, task, activity, `CI failed after ${job.attempt + 1} attempt(s): ${ci?.failureExcerpt || run.conclusion}`);
    return;
  }
  await emitParentEvent(mission.id, {
    kind: 'ci_failed',
    ref: `attempt-${job.attempt}`,
    text: `⚠️ CI failed (attempt ${job.attempt + 1}) — starting automated repair.\n${(ci?.failureExcerpt ?? '').slice(0, 800)}`,
  });
  const repairInstruction =
    `The CI workflow '${job.workflow}' failed on branch '${job.branch}'. Fix the build/test failures and push the fix to the same branch.\n\n` +
    `=== FAILURE EXCERPT ===\n${(ci?.failureExcerpt ?? 'no excerpt available').slice(0, 2000)}`;
  const codeTask = await (prisma as any).code_tasks.create({
    data: {
      workspace_id: mission.workspace_id,
      title: `${mission.title} — CI repair ${job.attempt + 1}`.slice(0, 300),
      repo: job.repo,
      instruction: repairInstruction,
      status: 'running',
      mission_id: mission.id,
      agent: 'build',
    },
  });
  const { toolCall } = await stageToolCall(mission, activity, 'code_task', {
    instruction: repairInstruction,
    repo: job.repo,
    branch: job.branch,
    code_task_id: codeTask.id,
    mission_id: mission.id,
  }, `CI repair attempt ${job.attempt + 1}`);
  executeToolCallViaApi(toolCall.id).catch(() => {});
  // Give the repair its OpenCode window, then re-dispatch CI.
  await ciPollQueue.add(
    'redispatch',
    { ...job, attempt: job.attempt + 1, dispatchedAt: Date.now(), redispatch: true, repairCodeTaskId: codeTask.id },
    { delay: 5 * 60_000, removeOnComplete: 500, removeOnFail: 500 },
  );
}

export async function redispatchCi(job: any) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: job.missionId } });
  const task = await prisma.tasks.findUnique({ where: { id: job.taskId } });
  const activity = await prisma.activities.findUnique({ where: { id: job.activityId } });
  if (!mission || !task || !activity) return;
  // Wait for the repair code_task to finish before re-running CI (max ~35 min).
  const repair = job.repairCodeTaskId
    ? await (prisma as any).code_tasks.findUnique({ where: { id: job.repairCodeTaskId }, select: { status: true } })
    : null;
  if (repair && repair.status === 'running' && Date.now() - job.dispatchedAt < CODE_STAGE_TIMEOUT_MS) {
    await ciPollQueue.add('redispatch', job, { delay: 60_000, removeOnComplete: 500, removeOnFail: 500 });
    return;
  }
  const { toolCall } = await stageToolCall(mission, activity, 'github_dispatch_workflow', {
    repo: job.repo,
    workflow: job.workflow,
    ref: job.branch,
  }, `Dev pod CI re-run (attempt ${job.attempt + 1})`);
  await executeToolCallViaApi(toolCall.id);
  await ciPollQueue.add('poll', { ...job, redispatch: undefined, dispatchedAt: Date.now() }, { delay: 90_000, removeOnComplete: 500, removeOnFail: 500 });
}

async function runPrStage(mission: any, task: any, activity: any, cfg: any) {
  const branch = devBranch(mission);
  const parent = ((mission.summary as any) ?? {}).parent ?? {};
  const analysis = await stageOutput(mission.id, 'analyze');
  const repo = cfg.repo as string;

  // Diff-size guard: an oversized or out-of-scope branch blocks instead of PR.
  try {
    const cmp = await internalGet(`/internal/github/compare?repo=${encodeURIComponent(repo)}&base=${encodeURIComponent(cfg.base ?? 'main')}&head=${encodeURIComponent(branch)}`);
    if (cmp?.configured && cmp?.files != null) {
      const maxFiles = Number(process.env.DEV_POD_MAX_PR_FILES ?? 40);
      if (cmp.files > maxFiles) throw new Error(`branch touches ${cmp.files} files (> ${maxFiles} cap)`);
      const outOfScope = (cmp.paths as string[] | undefined)?.some((p) => !/^(apps|docs|src)\//.test(p));
      if (outOfScope) throw new Error('branch touches paths outside apps/, docs/, src/ — human review required');
    }
  } catch (e) {
    if ((e as Error).message.includes('cap') || (e as Error).message.includes('outside')) throw e;
    // compare endpoint unavailable → proceed (draft PR + human merge is the gate)
  }

  const { sensitive } = await stageToolCall(mission, activity, 'github_create_pr', {
    repo,
    head: branch,
    base: cfg.base ?? 'main',
    title: `[AB#${parent.ado_id ?? '?'}] ${mission.title}`.slice(0, 250),
    body: `Automated dev-pod delivery for AB#${parent.ado_id ?? '?'}.\n\n## Analysis\n${analysis.slice(0, 2000)}\n\nAB#${parent.ado_id ?? ''}`,
    draft: true,
  }, `Dev pod PR: ${mission.title}`);

  if (sensitive) {
    // Approval-gated: the human decision resumes the graph via mission.advance.
    await prisma.activities.update({ where: { id: activity.id }, data: { status: 'awaiting_approval' } });
    return;
  }
  // Auto path: find the created tool_call and execute now.
  const toolCall = await prisma.tool_calls.findFirst({
    where: { name: 'github_create_pr', status: 'approved', agent_run: { activity_id: activity.id } },
    orderBy: { created_at: 'desc' },
  });
  if (toolCall) await executeToolCallViaApi(toolCall.id);
  await completeStage(mission, task, activity);
  const { advanceMissionFromActivity } = await import('./mission');
  await advanceMissionFromActivity(activity.id);
}
