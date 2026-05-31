import { PrismaClient } from '@dynops/db';

const prisma = new PrismaClient();

export async function runDailyBrief() {
  const workspaces = await prisma.workspaces.findMany({ where: { status: 'active' } });
  for (const ws of workspaces) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const now = new Date();
    const [
      newActivities,
      completed,
      escalations,
      pendingApprovals,
      dueTasks,
      overdueTasks,
      proactiveRuns,
    ] = await Promise.all([
      prisma.activities.count({ where: { workspace_id: ws.id, created_at: { gte: since } } }),
      prisma.activities.count({ where: { workspace_id: ws.id, status: 'completed', created_at: { gte: since } } }),
      prisma.activities.count({ where: { workspace_id: ws.id, status: 'escalated', created_at: { gte: since } } }),
      prisma.approvals.count({ where: { workspace_id: ws.id, status: 'pending' } }),
      prisma.tasks.count({ where: { workspace_id: ws.id, status: { in: ['open', 'in_progress', 'blocked'] }, due_date: { gte: now, lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) } } }),
      prisma.tasks.count({ where: { workspace_id: ws.id, status: { in: ['open', 'in_progress', 'blocked'] }, due_date: { lt: now } } }),
      prisma.agent_runs.findMany({
        where: { workspace_id: ws.id, created_at: { gte: since }, activity: { channel: 'proactive' } },
        orderBy: { created_at: 'desc' },
        take: 5,
        include: { activity: { select: { subject: true } }, ai_resource: { select: { name: true } } },
      }),
    ]);

    const latestProactiveOutputs = proactiveRuns.map((r) => ({
      resource: r.ai_resource.name,
      subject: r.activity.subject,
      reasoning: r.reasoning_summary,
      confidence: r.confidence_score ? Number(r.confidence_score) : null,
    }));
    const summary = {
      workspace: ws.name,
      periodHours: 24,
      newActivities,
      completed,
      escalations,
      pendingApprovals,
      dueTasks,
      overdueTasks,
      latestProactiveOutputs,
      delivery: process.env.DIGEST_EMAIL_TO ? 'email_draft_mock' : 'stored_only',
      generatedAt: now.toISOString(),
    };

    await (prisma as any).digest_results.create({
      data: {
        workspace_id: ws.id,
        kind: 'daily_exec_brief',
        status: 'created',
        summary,
        sent_to: process.env.DIGEST_EMAIL_TO ? [process.env.DIGEST_EMAIL_TO] : [],
      },
    });
    await (prisma as any).notifications.create({
      data: {
        workspace_id: ws.id,
        type: 'daily_exec_brief',
        title: 'Daily Executive Brief',
        message: `New: ${newActivities}, completed: ${completed}, escalations: ${escalations}, pending approvals: ${pendingApprovals}, due/overdue tasks: ${dueTasks}/${overdueTasks}.`,
        metadata: summary,
      },
    });
    console.log(`[daily-brief] ${ws.name}: ${JSON.stringify(summary)}`);
  }
}
