import { PrismaClient } from '@dynops/db';
import type { Queue } from 'bullmq';
import { processActivity } from './process-activity';

const prisma = new PrismaClient();

const CADENCE_MS: Record<string, number> = {
  daily: 86400_000,
  weekly: 7 * 86400_000,
  monthly: 30 * 86400_000,
  quarterly: 90 * 86400_000,
};

// Run ONE proactive automation: create a synthetic `proactive` activity pinned
// to the automation's resource, then push it through the normal draft-first
// pipeline. The agent will draft a deliverable, create tasks, and hand off to
// the partner departments named in the objective (cross-department automation).
export async function runProactive(automationId: string) {
  const automation = await (prisma as any).automations.findUnique({
    where: { id: automationId },
    include: { resource: true },
  });
  if (!automation || !automation.resource) {
    console.log(`[proactive] automation ${automationId} not found — skipping`);
    return;
  }
  if (!automation.is_active) {
    console.log(`[proactive] automation ${automationId} inactive — skipping`);
    return;
  }

  const handoffTo: string[] = Array.isArray(automation.handoff_to) ? automation.handoff_to : [];
  const sampleTasks: string[] = Array.isArray(automation.sample_tasks) ? automation.sample_tasks : [];

  // Resolve handoff target display names for a clearer instruction.
  const targets = handoffTo.length
    ? await prisma.ai_resources.findMany({ where: { key: { in: handoffTo } }, select: { key: true, name: true } })
    : [];
  const targetNames = targets.map((t) => `${t.name} (${t.key})`).join(', ') || 'the relevant departments';

  const today = new Date().toISOString().slice(0, 10);
  const body = [
    `PROACTIVE OBJECTIVE (${automation.cadence}): ${automation.name}`,
    ``,
    automation.objective,
    ``,
    `Today is ${today}. Produce your standard deliverable for this objective, then:`,
    `- create_task for each concrete next action${sampleTasks.length ? ` (e.g. ${sampleTasks.join('; ')})` : ''}.`,
    `- handoff to each of these departments so the work flows across the org: ${targetNames}.`,
    `Use the resource keys above as the handoff "to" value.`,
  ].join('\n');

  const activity = await prisma.activities.create({
    data: {
      workspace_id: automation.workspace_id ?? undefined,
      channel: 'proactive',
      subject: `[Proactive] ${automation.name}`,
      body,
      status: 'new',
      priority: 'normal',
      assigned_resource_id: automation.resource_id,
      metadata: { proactive: true, automation_id: automation.id, handoff_depth: 0, handoff_to: handoffTo },
    },
  });

  await (prisma as any).automations.update({
    where: { id: automationId },
    data: { last_run_at: new Date(), run_count: { increment: 1 } },
  });

  console.log(`[proactive] ${automation.resource.name} → "${automation.name}" (activity ${activity.id})`);
  await processActivity(activity.id);
}

// Scheduler tick: enqueue the due automations (next_run_at null or <= now),
// capped per tick so the first run doesn't flood. Advances each one's
// next_run_at by its cadence so subsequent runs follow the schedule.
export async function tickProactiveScheduler(queue: Queue, batch = 5) {
  const now = new Date();
  const due = await (prisma as any).automations.findMany({
    where: { is_active: true, OR: [{ next_run_at: null }, { next_run_at: { lte: now } }] },
    orderBy: [{ next_run_at: { sort: 'asc', nulls: 'first' } }],
    take: batch,
  });
  if (!due.length) return 0;

  for (const a of due) {
    const intervalMs = Number((a.config as any)?.cadence_ms ?? CADENCE_MS[a.cadence] ?? CADENCE_MS.weekly);
    // Advance the schedule BEFORE enqueueing so a slow/failed run can't double-fire.
    await (prisma as any).automations.update({
      where: { id: a.id },
      data: { next_run_at: new Date(now.getTime() + intervalMs) },
    });
    await queue.add('run', { automationId: a.id }, { removeOnComplete: 200, removeOnFail: 200 });
  }
  console.log(`[proactive] scheduler enqueued ${due.length} due automation(s)`);
  return due.length;
}
