import { BadRequestException, Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { AgentRunRequest } from '@dynops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { currentWorkspaceId } from '../../common/tenant';
import { runReport, REPORT_CATALOG_KEYS } from './reports.service';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

async function runAnalystAgent(req: AgentRunRequest) {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

@Controller('analyst')
class AnalystController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('reports')
  getCatalog() {
    return { keys: [...REPORT_CATALOG_KEYS] };
  }

  @Post('ask')
  async ask(@Body() body: { question: string }) {
    if (!body?.question?.trim()) throw new BadRequestException('question is required');

    const resource = await this.prisma.ai_resources.findUnique({ where: { key: 'ai_data_analyst' } });
    if (!resource) throw new BadRequestException('ai_data_analyst resource is not seeded. Run the database seed.');

    const req: AgentRunRequest = {
      run_id: `analyst-${Date.now()}`,
      workspace_id: currentWorkspaceId() ?? undefined,
      ai_resource: {
        key: resource.key,
        name: resource.name,
        system_prompt: resource.system_prompt,
        provider: resource.llm_provider,
        model: resource.llm_model,
        temperature: Number(resource.temperature),
        tools: (resource.allowed_tools as string[]) ?? [],
        confidence_threshold: Number(resource.confidence_threshold),
      },
      activity: {
        id: `analyst-ask-${Date.now()}`,
        channel: 'manual',
        subject: 'Analytics question',
        body: body.question,
        priority: 'normal',
        customer: null,
      },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 5 },
    };

    let resp: any;
    try {
      resp = await runAnalystAgent(req);
    } catch (e) {
      throw new BadRequestException(`Agent call failed: ${(e as Error).message}`);
    }

    // Find run_report intent and execute it
    const reportIntent = (resp.tool_intents ?? []).find((i: any) => i.tool === 'run_report');
    const chartIntent = (resp.tool_intents ?? []).find((i: any) => i.tool === 'make_chart');

    let report: any = null;
    if (reportIntent?.args?.report) {
      try {
        report = await runReport(this.prisma, reportIntent.args.report, reportIntent.args.params);
      } catch (e) {
        // Fallback: try the first catalog key
        report = await runReport(this.prisma, 'activities_by_status', {});
      }
    }

    // Build chart spec: prefer the make_chart intent, fallback to suggestedChart from report
    let chart: any = null;
    if (chartIntent?.args) {
      const type = ['bar', 'donut', 'line'].includes(chartIntent.args.type) ? chartIntent.args.type : 'bar';
      chart = { type, title: chartIntent.args.title ?? report?.suggestedChart?.title ?? 'Chart', ...chartIntent.args };
    } else if (report?.suggestedChart) {
      chart = report.suggestedChart;
    }

    return {
      answer: resp.draft?.content ?? null,
      report: report ?? null,
      chart: chart ?? null,
    };
  }
}

@Module({ controllers: [AnalystController] })
export class AnalystModule {}
