import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('dashboard')
class DashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary() {
    const [activitiesHandled, pendingApprovals, escalations, overdueTasks, runs] = await Promise.all([
      this.prisma.activities.count({ where: { status: 'completed' } }),
      this.prisma.approvals.count({ where: { status: 'pending' } }),
      this.prisma.activities.count({ where: { status: 'escalated' } }),
      this.prisma.tasks.count({ where: { status: { in: ['open', 'in_progress'] }, due_date: { lt: new Date() } } }),
      this.prisma.agent_runs.aggregate({ _avg: { confidence_score: true, latency_ms: true }, _count: true }),
    ]);
    // crude "time saved": 15 min per AI-handled activity
    const timeSavedMins = activitiesHandled * 15;
    return {
      activitiesHandled,
      pendingApprovals,
      escalations,
      overdueTasks,
      agentRuns: runs._count,
      avgConfidence: runs._avg.confidence_score ? Number(runs._avg.confidence_score) : null,
      avgResponseMs: runs._avg.latency_ms ? Math.round(Number(runs._avg.latency_ms)) : null,
      timeSavedMins,
    };
  }

  @Get('agent-performance')
  async agentPerformance() {
    const resources = await this.prisma.ai_resources.findMany({ select: { id: true, name: true, key: true } });
    const out = [] as any[];
    for (const r of resources) {
      const agg = await this.prisma.agent_runs.aggregate({ where: { ai_resource_id: r.id }, _count: true, _avg: { confidence_score: true, latency_ms: true } });
      const escalations = await this.prisma.agent_runs.count({ where: { ai_resource_id: r.id, status: 'needs_approval' } });
      out.push({
        aiResourceId: r.id,
        name: r.name,
        key: r.key,
        handled: agg._count,
        avgConfidence: agg._avg.confidence_score ? Number(agg._avg.confidence_score) : null,
        avgResponseMs: agg._avg.latency_ms ? Math.round(Number(agg._avg.latency_ms)) : null,
        escalations,
      });
    }
    return out;
  }

  // Per-connection in/out counting (Connection Registry).
  @Get('connection-throughput')
  async connectionThroughput() {
    const integrations = await this.prisma.integrations.findMany();
    const out = [] as any[];
    for (const i of integrations) {
      const inbound = await this.prisma.activities.count({ where: { source: { integration_id: i.id } } });
      const outbound = await this.prisma.tool_calls.count({ where: { target_integration_id: i.id, status: 'succeeded' } });
      out.push({ id: i.id, name: i.name, type: i.type, direction: i.direction, mode: i.is_mock ? 'mock' : 'real', inbound, outbound });
    }
    return out;
  }

  @Get('ai-vs-human')
  async aiVsHuman() {
    const [autoExecuted, humanApproved, escalated] = await Promise.all([
      this.prisma.tool_calls.count({ where: { status: 'succeeded', requires_approval: false } }),
      this.prisma.tool_calls.count({ where: { status: 'succeeded', requires_approval: true } }),
      this.prisma.activities.count({ where: { status: 'escalated' } }),
    ]);
    return { autoExecuted, humanApproved, escalated };
  }

  // Executive ROI / value. Hours & $ saved, automation rate, SLA attainment.
  @Get('roi')
  async roi() {
    const completed = await this.prisma.activities.count({ where: { status: 'completed' } });
    const escalated = await this.prisma.activities.count({ where: { status: 'escalated' } });
    const total = completed + escalated || 1;
    const MIN_PER = 15; // analyst minutes saved per AI-handled activity
    const RATE = 85; // blended $/hour
    const hoursSaved = Math.round((completed * MIN_PER) / 60 * 10) / 10;
    // SLA: share of completed activities with a first response < 60 min
    const withResponse = await this.prisma.activities.findMany({
      where: { first_response_at: { not: null } },
      select: { received_at: true, first_response_at: true },
      take: 500,
    });
    const slaOk = withResponse.filter((a) => a.first_response_at && a.received_at && (+a.first_response_at - +a.received_at) < 3600_000).length;
    const slaPct = withResponse.length ? Math.round((slaOk / withResponse.length) * 100) : 100;
    const avgResp = withResponse.length
      ? Math.round(withResponse.reduce((s, a) => s + (a.first_response_at && a.received_at ? +a.first_response_at - +a.received_at : 0), 0) / withResponse.length / 1000)
      : null;
    return {
      hoursSaved,
      valueSaved: Math.round(hoursSaved * RATE),
      automationRate: Math.round((completed / total) * 100),
      completed,
      escalated,
      slaPct,
      avgFirstResponseSec: avgResp,
    };
  }

  // Token usage + estimated cost per resource (AI governance / budget).
  @Get('usage')
  async usage() {
    const COST: Record<string, number> = { // $ per 1K output tokens (rough)
      'claude-opus-4-8': 0.015, 'claude-sonnet-4-6': 0.003, 'gpt-4o': 0.01, 'gpt-4o-mini': 0.0006,
    };
    const runs = await this.prisma.agent_runs.findMany({
      select: { ai_resource_id: true, llm_provider: true, llm_model: true, prompt_tokens: true, completion_tokens: true },
      take: 5000,
    });
    const resources = await this.prisma.ai_resources.findMany({ select: { id: true, name: true } });
    const nameById = Object.fromEntries(resources.map((r) => [r.id, r.name]));
    const byResource: Record<string, any> = {};
    let totalCost = 0, totalTokens = 0;
    for (const r of runs) {
      const key = r.ai_resource_id;
      const out = r.completion_tokens ?? 0;
      const inp = r.prompt_tokens ?? 0;
      const isLocal = r.llm_provider === 'ollama';
      const cost = isLocal ? 0 : (out / 1000) * (COST[r.llm_model] ?? 0.005);
      totalCost += cost; totalTokens += out + inp;
      byResource[key] ??= { name: nameById[key] ?? key, model: r.llm_model, provider: r.llm_provider, runs: 0, tokens: 0, cost: 0, local: isLocal };
      byResource[key].runs++; byResource[key].tokens += out + inp; byResource[key].cost += cost;
    }
    return {
      totalCost: Math.round(totalCost * 100) / 100,
      totalTokens,
      localShare: runs.length ? Math.round((runs.filter((r) => r.llm_provider === 'ollama').length / runs.length) * 100) : 0,
      byResource: Object.values(byResource).map((r: any) => ({ ...r, cost: Math.round(r.cost * 100) / 100 })),
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
