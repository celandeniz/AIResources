import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';
import { CosmosTimelogService } from '../../integrations/cosmos/timelog.service';
import { buildReport } from './report-builder';
import { renderReportHtml } from './report-html';

// ─────────────────────────────────────────────────────────────────────────────
// ReportsController
// ─────────────────────────────────────────────────────────────────────────────
@Controller('reports')
class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cosmos: CosmosTimelogService,
  ) {}

  // ── GET /reports/organizations ───────────────────────────────────────────
  @Get('organizations')
  listOrganizations() {
    return this.cosmos.listOrganizations();
  }

  // ── GET /reports/projects?customerId= ───────────────────────────────────
  @Get('projects')
  async listProjects(@Query('customerId') customerId: string) {
    if (!customerId) return [];
    // customerId is the core_customers id; org_name is the filter key in the
    // timelog/task containers. Resolve it before querying projects.
    const orgs = await this.cosmos.listOrganizations();
    const org = orgs.find((o) => o.id === customerId);
    return this.cosmos.listProjects(org?.org_name ?? customerId);
  }

  // ── GET /reports ─────────────────────────────────────────────────────────
  @Get()
  list() {
    const wsId = currentWorkspaceId();
    return (this.prisma as any).reports.findMany({
      where: wsId ? { workspace_id: wsId } : {},
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        scope: true,
        org_label: true,
        project_label: true,
        period_label: true,
        period_start: true,
        period_end: true,
        status: true,
        totals: true,
        customer_id: true,
        hourly_rate: true,
        currency: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  // ── GET /reports/:id ─────────────────────────────────────────────────────
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).reports.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
    });
    if (!row) throw new NotFoundException('report not found');
    return row;
  }

  // ── GET /reports/:id/html ────────────────────────────────────────────────
  @Get(':id/html')
  async getHtml(@Param('id') id: string, @Res() res: Response) {
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).reports.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
      select: { html_snapshot: true },
    });
    if (!row) throw new NotFoundException('report not found');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(row.html_snapshot ?? '<html><body>No snapshot available.</body></html>');
  }

  // ── POST /reports ────────────────────────────────────────────────────────
  @Roles('manager')
  @Post()
  async create(
    @Body() body: {
      scope: 'organization' | 'project';
      customerId: string;
      projectLabel?: string;
      periodLabel?: string;
      from: string; // ISO date string e.g. "2026-04-01"
      to: string;   // ISO date string e.g. "2026-04-30"
      grouping?: { byTask?: boolean; byResource?: boolean };
      hourlyRate?: number;
      currency?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body.customerId) throw new BadRequestException('customerId is required');
    if (!body.from || !body.to) throw new BadRequestException('from and to dates are required');

    const fromMs = new Date(body.from).getTime();
    const toMs = new Date(body.to + 'T23:59:59Z').getTime();
    if (isNaN(fromMs) || isNaN(toMs)) throw new BadRequestException('Invalid date format (use ISO date)');

    // Resolve org from Cosmos organisations. org_name is the FILTER key in the
    // timelog/task containers (customer_id is empty there); display_name is the label.
    const orgs = await this.cosmos.listOrganizations();
    const org = orgs.find((o) => o.id === body.customerId);
    const orgName = org?.org_name ?? body.customerId;
    const orgLabel = org?.display_name ?? org?.org_name ?? body.customerId;

    const grouping = {
      byTask: body.grouping?.byTask !== false,
      byResource: body.grouping?.byResource !== false,
    };

    // Fetch data from Cosmos
    const [timelogs, tasks] = await Promise.all([
      this.cosmos.fetchTimelogs({
        org: orgName,
        project: body.scope === 'project' ? body.projectLabel : undefined,
        fromMs,
        toMs,
      }),
      this.cosmos.fetchTasks({
        org: orgName,
        project: body.scope === 'project' ? body.projectLabel : undefined,
      }),
    ]);

    // Resolve user names
    const userIds = [...new Set(timelogs.map((t) => t.userId).filter(Boolean))];
    const userNames = await this.cosmos.resolveUserNames(userIds);

    // Build period label
    const periodLabel = body.periodLabel ?? `${body.from} – ${body.to}`;

    // Build report data
    const reportData = buildReport({
      orgLabel,
      projectLabel: body.scope === 'project' ? body.projectLabel : undefined,
      periodLabel,
      timelogs,
      tasks,
      userNames,
      grouping,
    });

    // Render HTML
    const html = renderReportHtml(reportData);

    // Title
    const title = body.scope === 'project'
      ? `${orgLabel} · ${body.projectLabel ?? ''} · ${periodLabel}`
      : `${orgLabel} · ${periodLabel}`;

    // Persist
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).reports.create({
      data: {
        workspace_id: wsId ?? undefined,
        title: title.slice(0, 300),
        scope: body.scope,
        customer_id: body.customerId,
        project_label: body.projectLabel ?? null,
        org_label: orgLabel,
        period_label: periodLabel,
        period_start: new Date(body.from),
        period_end: new Date(body.to),
        grouping: grouping as any,
        status: 'draft',
        totals: {
          grand: reportData.grand,
          projectTotals: reportData.projectTotals,
          resourceTotals: reportData.resourceTotals,
          taskTotals: reportData.taskTotals,
        } as any,
        line_items: reportData.taskTotals as any,
        html_snapshot: html,
        hourly_rate: body.hourlyRate ?? null,
        currency: body.currency ?? null,
        created_by: user.id ?? null,
      },
    });

    return row;
  }

  // ── POST /reports/:id/create-bc-order ────────────────────────────────────
  @Roles('manager')
  @Post(':id/create-bc-order')
  async createBcOrder(
    @Param('id') id: string,
    @Body() body: {
      company: string;     // BC company name (one of the two seeded companies)
      hourlyRate?: number;
      currency?: string;
      bcCustomer?: string; // BC customer code
      effortBasis?: 'workitem' | 'timer'; // which effort drives invoice qty (default: workitem)
    },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body.company) throw new BadRequestException('company is required');
    const effortBasis = body.effortBasis === 'timer' ? 'timer' : 'workitem';

    const wsId = currentWorkspaceId();
    const report = await (this.prisma as any).reports.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
    });
    if (!report) throw new NotFoundException('report not found');

    const hourlyRate = body.hourlyRate ?? (report.hourly_rate ? Number(report.hourly_rate) : 0);
    const currency = body.currency ?? report.currency ?? 'TRY';

    // Build task-based lines from line_items (taskTotals stored at report creation).
    // Quantity = the chosen effort basis: workItemEffort (ADO completed_work, the
    // customer-facing effort) or approvedEffort (timer Σduration). Fall back to the
    // timer value if a work item has no work-item effort recorded.
    const qtyOf = (t: any): number => {
      const wi = Number(t.workItemEffort ?? 0);
      const timer = Number(t.approvedEffort ?? 0);
      return effortBasis === 'timer' ? timer : (wi || timer);
    };
    const taskTotals: any[] = Array.isArray(report.line_items) ? report.line_items : [];
    const lines = taskTotals
      .map((t: any) => ({ t, qty: qtyOf(t) }))
      .filter(({ qty }) => qty > 0)
      .map(({ t, qty }) => ({
        description: `[${t.workItemId}] ${t.title}`,
        quantity: qty,
        unitPrice: hourlyRate,
        lineAmount: Math.round(qty * hourlyRate * 100) / 100,
      }));

    if (!lines.length) {
      throw new BadRequestException('No task lines with effort found. Cannot create BC order.');
    }

    const totalAmount = Math.round(lines.reduce((s: number, l: any) => s + l.lineAmount, 0) * 100) / 100;

    // ── Approval-gated path ─────────────────────────────────────────────────
    // We create a lightweight synthetic activity + agent_run to satisfy the
    // NOT NULL FK constraints on tool_calls and approvals. The approval then
    // appears in the Approval Center like any other sensitive tool.

    // 1. Synthetic activity
    const activity = await this.prisma.activities.create({
      data: {
        workspace_id: wsId ?? undefined,
        channel: 'manual',
        subject: `BC Satış Siparişi — ${report.title}`,
        body: `Rapor bazlı BC satış siparişi talebi: ${report.org_label} · ${report.period_label}`,
        status: 'awaiting_approval',
        metadata: { source: 'report', report_id: id, bc_order_request: true } as any,
      },
    });

    // 2. Any active AI resource for the agent_run FK
    const anyResource = await this.prisma.ai_resources.findFirst({ where: { status: 'active' } });
    if (!anyResource) {
      throw new BadRequestException('No active AI resource found; cannot create agent_run');
    }

    // 3. Synthetic agent_run
    const agentRun = await this.prisma.agent_runs.create({
      data: {
        workspace_id: wsId ?? undefined,
        activity_id: activity.id,
        ai_resource_id: anyResource.id,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-6',
        status: 'needs_approval',
        input: { report_id: id, bc_order_request: body } as any,
        output: {} as any,
        tools_used: ['bc_create_sales_order'] as any,
      },
    });

    // 4. Tool call
    const toolCall = await this.prisma.tool_calls.create({
      data: {
        workspace_id: wsId ?? undefined,
        agent_run_id: agentRun.id,
        name: 'bc_create_sales_order',
        args: {
          company: body.company,
          bcCustomer: body.bcCustomer ?? report.org_label,
          currency,
          lines,
          report_id: id,
        } as any,
        requires_approval: true,
        risk_level: 'high',
        status: 'awaiting_approval',
        sequence: 0,
      },
    });

    // 5. Approval record
    const approval = await this.prisma.approvals.create({
      data: {
        workspace_id: wsId ?? undefined,
        activity_id: activity.id,
        agent_run_id: agentRun.id,
        tool_call_id: toolCall.id,
        action: 'bc_create_sales_order',
        payload: {
          company: body.company,
          bcCustomer: body.bcCustomer ?? report.org_label,
          currency,
          hourlyRate,
          effortBasis,
          lines,
          totalAmount,
          report_id: id,
          report_title: report.title,
        } as any,
        risk_level: 'high',
        amount: totalAmount as any,
        reason: `BC satış siparişi: ${report.org_label} · ${report.period_label} · ${lines.length} kalem · ${effortBasis === 'timer' ? 'Timer süresi' : 'İş öğesi eforu'} · toplam ${totalAmount} ${currency}`,
        status: 'pending',
        requested_by_id: user.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Remember bc_company on the Prisma customer row (non-critical)
    if (report.customer_id) {
      try {
        const existingCustomer = await this.prisma.customers.findFirst({
          where: { id: report.customer_id },
        });
        if (existingCustomer) {
          const meta = ((existingCustomer.metadata as any) ?? {}) as Record<string, any>;
          await this.prisma.customers.update({
            where: { id: existingCustomer.id },
            data: { metadata: { ...meta, bc_company: body.company } as any },
          });
        }
      } catch { /* non-critical: best-effort */ }
    }

    return {
      ok: true,
      approval_id: approval.id,
      tool_call_id: toolCall.id,
      activity_id: activity.id,
      message: 'BC satış siparişi onay talebi oluşturuldu — Onay Merkezi\'nde inceleme bekliyor.',
      effortBasis,
      lines,
      totalAmount,
      currency,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────
@Module({
  controllers: [ReportsController],
  providers: [CosmosTimelogService],
})
export class ReportsModule {}
