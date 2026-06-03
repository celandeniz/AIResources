import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';
import { CosmosTimelogService, type CosmosTask } from '../../integrations/cosmos/timelog.service';
import { gatherProjectMail } from './mail-gather';
import { synthesizeStatus, type DevopsSummary } from './synthesize';
import { renderStatusHtml } from './status-html';

// ─────────────────────────────────────────────────────────────────────────────
// StatusReportsController — AI-generated project status reports with risks.
// Synthesised from Azure DevOps work items (Cosmos) + Outlook emails (Graph).
// ─────────────────────────────────────────────────────────────────────────────
@Controller('status-reports')
class StatusReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cosmos: CosmosTimelogService,
  ) {}

  // ── GET /status-reports ────────────────────────────────────────────────────
  @Get()
  list() {
    const wsId = currentWorkspaceId();
    return (this.prisma as any).status_reports.findMany({
      where: wsId ? { workspace_id: wsId } : {},
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        org_label: true,
        project_label: true,
        period_label: true,
        period_start: true,
        period_end: true,
        health: true,
        status: true,
        created_at: true,
      },
    });
  }

  // ── GET /status-reports/:id ────────────────────────────────────────────────
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).status_reports.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
    });
    if (!row) throw new NotFoundException('status report not found');
    return row;
  }

  // ── GET /status-reports/:id/html ───────────────────────────────────────────
  @Get(':id/html')
  async getHtml(@Param('id') id: string, @Res() res: Response) {
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).status_reports.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
      select: { html_snapshot: true },
    });
    if (!row) throw new NotFoundException('status report not found');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(row.html_snapshot ?? '<html><body>No snapshot available.</body></html>');
  }

  // ── POST /status-reports ───────────────────────────────────────────────────
  @Roles('manager')
  @Post()
  async create(
    @Body() body: {
      customerId: string;
      projectLabel: string;
      from: string; // ISO date string e.g. "2026-04-01"
      to: string;   // ISO date string e.g. "2026-04-30"
      sources?: { devops?: boolean; outlook?: boolean; teams?: boolean };
      keywords?: string[];
    },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body.customerId) throw new BadRequestException('customerId is required');
    if (!body.projectLabel) throw new BadRequestException('projectLabel is required');
    if (!body.from || !body.to) throw new BadRequestException('from and to dates are required');

    const fromMs = new Date(body.from).getTime();
    const toMs = new Date(body.to + 'T23:59:59Z').getTime();
    if (isNaN(fromMs) || isNaN(toMs)) throw new BadRequestException('Invalid date format (use ISO date)');
    const fromISO = new Date(body.from).toISOString();
    const toISO = new Date(body.to + 'T23:59:59Z').toISOString();

    // Resolve org from Cosmos. org_name is the FILTER key in the task containers;
    // display_name is the human label.
    const orgs = await this.cosmos.listOrganizations();
    const org = orgs.find((o) => o.id === body.customerId);
    const orgName = org?.org_name ?? body.customerId;
    const orgLabel = org?.display_name ?? orgName;

    const sources = {
      devops: body.sources?.devops !== false,
      outlook: body.sources?.outlook !== false,
      teams: body.sources?.teams === true,
    };

    // Keywords default: project name + its tokens, deduped.
    const keywords = [...new Set([body.projectLabel, ...body.projectLabel.split(/\s+/)])]
      .map((k) => k.trim())
      .filter(Boolean);
    const finalKeywords = body.keywords?.length ? body.keywords : keywords;

    // ── Gather DevOps ─────────────────────────────────────────────────────────
    let devopsSummary: DevopsSummary | null = null;
    let devopsNotable: CosmosTask[] = [];
    if (sources.devops) {
      const tasks = await this.cosmos.fetchProjectTasks({ org: orgName, project: body.projectLabel });
      const byState: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let sumEstimate = 0;
      let sumCompleted = 0;
      let activeInPeriod = 0;
      for (const t of tasks) {
        const st = t.state ?? 'Unknown';
        byState[st] = (byState[st] ?? 0) + 1;
        const ty = t.workItemType ?? t.type ?? 'Unknown';
        byType[ty] = (byType[ty] ?? 0) + 1;
        sumEstimate += t.originalEstimate ?? 0;
        sumCompleted += t.completedWork ?? 0;
        // changed_at = the ADO last-changed date (the real activity signal).
        // updated_at is only the Cosmos sync time (≈ today for every row), so it
        // must NOT be used for period filtering.
        const changedStr = t.changedAt ?? t.updatedAt;
        if (changedStr) {
          const changedMs = new Date(changedStr).getTime();
          if (!isNaN(changedMs) && changedMs >= fromMs && changedMs <= toMs) activeInPeriod++;
        }
      }
      devopsSummary = {
        total: tasks.length,
        byState,
        byType,
        sumEstimate: Math.round(sumEstimate * 100) / 100,
        sumCompleted: Math.round(sumCompleted * 100) / 100,
        activeInPeriod,
      };
      // Notable: items changed within the period first, then by priority asc
      // (lower = more important), then most-recently-changed.
      const changedMs = (t: CosmosTask) => new Date(t.changedAt ?? t.updatedAt ?? 0).getTime();
      const inPeriod = (t: CosmosTask) => {
        const ms = changedMs(t);
        return !isNaN(ms) && ms >= fromMs && ms <= toMs;
      };
      devopsNotable = [...tasks]
        .sort((a, b) => {
          const ia = inPeriod(a) ? 0 : 1;
          const ib = inPeriod(b) ? 0 : 1;
          if (ia !== ib) return ia - ib;
          const pa = a.priority ?? 99;
          const pb = b.priority ?? 99;
          if (pa !== pb) return pa - pb;
          return changedMs(b) - changedMs(a);
        })
        .slice(0, 25);
    }

    // ── Gather Outlook ────────────────────────────────────────────────────────
    let mailDigest: { subject: string; from: string; at: string; preview: string }[] = [];
    let mailbox = 'deniz@dynamicsops.com';
    if (sources.outlook) {
      // Prefer a LIVE (is_mock=false) graph_email connection; fall back to any.
      const gm =
        (await this.prisma.integrations.findFirst({ where: { type: 'graph_email', is_mock: false } })) ??
        (await this.prisma.integrations.findFirst({ where: { type: 'graph_email' } }));
      mailbox = (gm?.config as any)?.mailbox ?? mailbox;
      mailDigest = await gatherProjectMail({ mailbox, fromISO, toISO, keywords: finalKeywords });
    }

    // ── Teams: not gathered (pluggable, not live yet) ──────────────────────────

    const inputs = {
      timeframe: { from: body.from, to: body.to },
      sources,
      keywords: finalKeywords,
      devops: devopsSummary,
      outlook: sources.outlook ? { count: mailDigest.length, mailbox } : null,
      teams: { connected: false },
    };

    // ── AI synthesis ───────────────────────────────────────────────────────────
    const resource = await this.prisma.ai_resources.findUnique({ where: { key: 'ai_project_manager' } });
    if (!resource) throw new BadRequestException('ai_project_manager resource not seeded');

    const periodLabel = `${body.from} – ${body.to}`;
    const title = `${orgLabel} · ${body.projectLabel} · Durum Raporu (${periodLabel})`;

    const findings = await synthesizeStatus({
      resource,
      orgLabel,
      projectLabel: body.projectLabel,
      periodLabel,
      devopsSummary,
      devopsNotable,
      mailDigest,
    });

    const html = renderStatusHtml({
      orgLabel,
      projectLabel: body.projectLabel,
      periodLabel,
      findings,
      inputs,
    });

    // ── Persist ──────────────────────────────────────────────────────────────
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).status_reports.create({
      data: {
        workspace_id: wsId ?? undefined,
        title: title.slice(0, 300),
        customer_id: body.customerId,
        org_label: orgLabel,
        project_label: body.projectLabel,
        period_label: periodLabel,
        period_start: new Date(body.from),
        period_end: new Date(body.to),
        sources: sources as any,
        keywords: finalKeywords as any,
        inputs: inputs as any,
        findings: findings as any,
        health: findings.health,
        html_snapshot: html,
        status: 'draft',
        created_by: user.id ?? null,
      },
    });

    return row;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────
@Module({
  controllers: [StatusReportsController],
  providers: [CosmosTimelogService],
})
export class StatusReportsModule {}
