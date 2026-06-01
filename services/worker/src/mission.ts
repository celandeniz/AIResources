import { PrismaClient } from '@dynops/db';
import { Queue } from 'bullmq';

const prisma = new PrismaClient();
const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
const activityQueue = new Queue('activity.process', { connection: { url } as any });

const STOP = new Set(['the', 'and', 'for', 'with', 'our', 'a', 'an', 'to', 'of', 'in', 'on', 'win', 'launch', 'build', 'create', 'new', 'plan', 'get', 'make', 'into']);
const MAX_WORKERS = 5;

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-zçğıöşü0-9]{3,}/gi) ?? []).filter((t) => !STOP.has(t));
}

// Deterministic, zero-key planner: score active resources against the goal and
// build a fan-out → fan-in task graph (lead scopes → specialists work → lead
// synthesizes). The agent then EXECUTES each task via the normal pipeline.
export async function planAndStartMission(missionId: string) {
  const mission = await (prisma as any).missions.findUnique({ where: { id: missionId } });
  if (!mission || mission.status !== 'planning') return;
  const wsId = mission.workspace_id;

  const resources = await prisma.ai_resources.findMany({ where: { status: 'active', workspace_id: wsId } });
  if (!resources.length) {
    await (prisma as any).missions.update({ where: { id: missionId }, data: { status: 'failed', summary: { error: 'no active resources' } } });
    return;
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

  for (const t of ready) {
    const resource = t.assignee_resource_id ? await prisma.ai_resources.findUnique({ where: { id: t.assignee_resource_id } }) : null;
    const activity = await prisma.activities.create({
      data: {
        workspace_id: mission.workspace_id,
        channel: 'mission',
        subject: `[Mission] ${t.title}`,
        body: `${t.description}\n\nYou are part of mission "${mission.title}". Produce your deliverable, create tasks for concrete actions, post_message a brief status to the mission, and handoff to teammates if needed.`,
        status: 'new',
        assigned_resource_id: t.assignee_resource_id,
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
    await (prisma as any).missions.update({
      where: { id: missionId },
      data: { status: 'done', summary: { tasks: fresh.length, done, completedAt: new Date().toISOString() } },
    });
    console.log(`[mission] ${mission.title}: DONE (${done}/${fresh.length} tasks)`);
  } else if (!ready.length && !open.some((t) => t.status === 'in_progress')) {
    // All remaining are open but blocked with no in-flight work → blocked.
    await (prisma as any).missions.update({ where: { id: missionId }, data: { status: 'blocked' } });
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
  await executeReadyTasks(meta.mission_id);
}
