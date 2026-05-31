import { PrismaClient } from '@dynops/db';

const prisma = new PrismaClient();

export async function runWeeklyDigest() {
  const workspaces = await prisma.workspaces.findMany({ where: { status: 'active' } });
  for (const ws of workspaces) {
    const since = new Date(Date.now() - 7 * 86400_000);
    const [completed, escalated, pendingApprovals, runs] = await Promise.all([
      prisma.activities.count({ where: { workspace_id: ws.id, status: 'completed', created_at: { gte: since } } }),
      prisma.activities.count({ where: { workspace_id: ws.id, status: 'escalated', created_at: { gte: since } } }),
      prisma.approvals.count({ where: { workspace_id: ws.id, status: 'pending' } }),
      prisma.agent_runs.aggregate({ where: { workspace_id: ws.id, created_at: { gte: since } }, _count: true, _avg: { confidence_score: true } }),
    ]);
    const hoursSaved = Math.round((completed * 15) / 60 * 10) / 10;
    const summary = {
      workspace: ws.name,
      periodDays: 7,
      completed,
      escalated,
      pendingApprovals,
      agentRuns: runs._count,
      avgConfidence: runs._avg.confidence_score ? Number(runs._avg.confidence_score) : null,
      hoursSaved,
      valueSaved: Math.round(hoursSaved * 85),
      delivery: process.env.DIGEST_EMAIL_TO ? 'email_mock' : 'stored_only',
    };
    await (prisma as any).digest_results.create({
      data: {
        workspace_id: ws.id,
        kind: 'weekly_exec_digest',
        status: 'created',
        summary,
        sent_to: process.env.DIGEST_EMAIL_TO ? [process.env.DIGEST_EMAIL_TO] : [],
      },
    });
    console.log(`[digest] weekly exec digest for ${ws.name}: ${JSON.stringify(summary)}`);
  }
}
