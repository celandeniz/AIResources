import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('performance')
class PerformanceController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const resources = await this.prisma.ai_resources.findMany({
      select: { id: true, name: true, key: true, role: true },
      orderBy: { name: 'asc' },
    });

    const out: any[] = [];

    for (const r of resources) {
      // agent_runs aggregation
      const runsAgg = await this.prisma.agent_runs.aggregate({
        where: { ai_resource_id: r.id },
        _count: true,
        _avg: { confidence_score: true },
      });

      // activities handled (completed) and status counts
      const activitiesHandled = await this.prisma.activities.count({
        where: { assigned_resource_id: r.id, status: 'completed' },
      });
      const escalated = await this.prisma.activities.count({
        where: { assigned_resource_id: r.id, status: 'escalated' },
      });
      const awaitingApproval = await this.prisma.activities.count({
        where: { assigned_resource_id: r.id, status: 'awaiting_approval' },
      });

      // approvals approved / rejected via agent_runs join
      const approvedCount = await this.prisma.approvals.count({
        where: {
          status: 'approved',
          agent_run: { ai_resource_id: r.id },
        },
      });
      const rejectedCount = await this.prisma.approvals.count({
        where: {
          status: 'rejected',
          agent_run: { ai_resource_id: r.id },
        },
      });

      // feedback thumbs — agent_feedback has no relation to agent_runs, so resolve
      // this resource's run ids first, then count feedback by agent_run_id.
      const runRows = await this.prisma.agent_runs.findMany({ where: { ai_resource_id: r.id }, select: { id: true } });
      const runIds = runRows.map((x) => x.id);
      const thumbsUp = runIds.length ? await (this.prisma as any).agent_feedback.count({ where: { rating: 'up', agent_run_id: { in: runIds } } }) : 0;
      const thumbsDown = runIds.length ? await (this.prisma as any).agent_feedback.count({ where: { rating: 'down', agent_run_id: { in: runIds } } }) : 0;

      const runs = runsAgg._count;
      const avgConfidence = runsAgg._avg.confidence_score ? Number(runsAgg._avg.confidence_score) : null;
      const acceptanceRate = approvedCount + rejectedCount > 0
        ? Math.round((approvedCount / (approvedCount + rejectedCount)) * 100) / 100
        : null;
      const hoursSaved = Math.round(activitiesHandled * 0.25 * 100) / 100;

      out.push({
        aiResourceId: r.id,
        name: r.name,
        key: r.key,
        role: r.role,
        runs,
        avgConfidence,
        activitiesHandled,
        escalated,
        awaitingApproval,
        approved: approvedCount,
        rejected: rejectedCount,
        acceptanceRate,
        thumbsUp,
        thumbsDown,
        hoursSaved,
      });
    }

    // Sort by activitiesHandled desc
    out.sort((a, b) => b.activitiesHandled - a.activitiesHandled);

    return out;
  }
}

@Module({ controllers: [PerformanceController] })
export class PerformanceModule {}
