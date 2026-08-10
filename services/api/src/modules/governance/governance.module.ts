// ECC-inspired governance surface:
//  - /rules        — always-on standards injected into every agent prompt
//  - /guard-hooks  — deterministic pre-execution checks (executor enforces)
//  - /security-audit — AgentShield-style config scanner: deterministic checks
//    over resources/integrations/automations/env, scored 0-100.

import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { AuditModule, AuditService } from '../../common/audit.service';
import { ALWAYS_APPROVE, TOOL_REGISTRY, isKnownTool } from '@dynops/shared';

// ── Rules ─────────────────────────────────────────────────────────────────────

@Controller('rules')
export class RulesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return (this.prisma as any).workspace_rules.findMany({ orderBy: [{ scope: 'asc' }, { sort: 'asc' }] });
  }

  @Roles('admin')
  @Post()
  create(@Body() body: { scope?: string; title: string; body: string; sort?: number }) {
    return (this.prisma as any).workspace_rules.create({
      data: { scope: body.scope ?? 'workspace', title: String(body.title).slice(0, 200), body: String(body.body), sort: body.sort ?? 0 },
    });
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    const data: any = {};
    for (const k of ['scope', 'title', 'body', 'is_active', 'sort']) if (body[k] !== undefined) data[k] = body[k];
    return (this.prisma as any).workspace_rules.update({ where: { id }, data });
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return (this.prisma as any).workspace_rules.delete({ where: { id } });
  }
}

// ── Guard hooks ───────────────────────────────────────────────────────────────

@Controller('guard-hooks')
export class GuardHooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return (this.prisma as any).guard_hooks.findMany({ orderBy: { created_at: 'asc' } });
  }

  @Roles('admin')
  @Post()
  create(@Body() body: { tool_pattern: string; check: string; config?: any; action?: string }) {
    return (this.prisma as any).guard_hooks.create({
      data: {
        tool_pattern: String(body.tool_pattern).slice(0, 80),
        check: String(body.check).slice(0, 40),
        config: body.config ?? {},
        action: body.action === 'block' ? 'block' : 'warn',
      },
    });
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    const data: any = {};
    for (const k of ['tool_pattern', 'check', 'config', 'action', 'is_active']) if (body[k] !== undefined) data[k] = body[k];
    return (this.prisma as any).guard_hooks.update({ where: { id }, data });
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return (this.prisma as any).guard_hooks.delete({ where: { id } });
  }
}

// ── Security audit (AgentShield) ──────────────────────────────────────────────

interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  entity: string;
  finding: string;
  remediation: string;
}

const SEVERITY_WEIGHT: Record<Finding['severity'], number> = { critical: 25, high: 12, medium: 6, low: 2 };

@Controller('security-audit')
export class SecurityAuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Roles('admin')
  @Get()
  async run() {
    const findings: Finding[] = [];

    // 1. Resources with sensitive tools + a low confidence threshold.
    const resources = await this.prisma.ai_resources.findMany({ where: { status: 'active' } });
    for (const r of resources) {
      const tools = ((r.allowed_tools as string[]) ?? []).filter(isKnownTool);
      const sensitiveTools = tools.filter((t) => TOOL_REGISTRY[t].sensitive);
      const threshold = Number(r.confidence_threshold);
      if (sensitiveTools.length && threshold < 0.5) {
        findings.push({
          id: `res-threshold-${r.key}`, severity: 'high', entity: r.key,
          finding: `Sensitive tools (${sensitiveTools.slice(0, 3).join(', ')}…) with confidence_threshold ${threshold} < 0.5`,
          remediation: 'Raise the confidence threshold or remove sensitive tools from this resource.',
        });
      }
      const monetary = tools.filter((t) => TOOL_REGISTRY[t].monetary);
      if (monetary.length && r.approval_limit == null) {
        findings.push({
          id: `res-limit-${r.key}`, severity: 'high', entity: r.key,
          finding: `Monetary tools (${monetary.join(', ')}) with NO approval_limit`,
          remediation: 'Set an approval limit so value-bearing actions are bounded.',
        });
      }
      const powerTools = tools.filter((t) => ['code_task', 'phone_task'].includes(t));
      if (powerTools.length && !['ai_al_developer', 'ai_technical_consultant'].includes(r.key)) {
        findings.push({
          id: `res-power-${r.key}`, severity: 'medium', entity: r.key,
          finding: `High-impact tool(s) ${powerTools.join(', ')} on an unexpected resource`,
          remediation: 'Keep code_task/phone_task limited to purpose-built resources.',
        });
      }
    }

    // 2. Live integrations whose credential set is missing (mock/live mismatch).
    const liveRows = await this.prisma.integrations.findMany({ where: { is_mock: false } });
    const credGate: Record<string, boolean> = {
      graph_email: Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET),
      graph_teams: Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET),
      ado_org: Boolean(process.env.ADO_PAT && process.env.ADO_ORGS),
      github: Boolean(process.env.GITHUB_TOKEN),
      whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
    };
    for (const row of liveRows) {
      if (row.type in credGate && !credGate[row.type]) {
        findings.push({
          id: `int-cred-${row.id}`, severity: 'medium', entity: row.name,
          finding: `Integration is marked LIVE (is_mock=false) but its ${row.type} credentials are not set — actions silently route to the mock adapter`,
          remediation: 'Set the credentials or flip the row back to mock.',
        });
      }
    }

    // 3. Webhook endpoints with unset secrets.
    if (!process.env.ADO_WEBHOOK_SECRET && process.env.ENABLE_ADO_INGESTION !== 'false') {
      findings.push({
        id: 'env-ado-webhook', severity: 'low', entity: 'env',
        finding: 'ADO_WEBHOOK_SECRET unset — the ADO service-hook receiver is disabled (fail-closed)',
        remediation: 'Set a random secret and configure the ADO service hooks to enable push ingestion.',
      });
    }

    // 4. Autosend enabled without protective caps.
    if (process.env.ENABLE_COVERAGE_AUTOSEND === 'true') {
      if (Number(process.env.COVERAGE_MAX_AUTOSENDS_PER_CUSTOMER_DAY ?? 2) > 5) {
        findings.push({
          id: 'env-autosend-cap', severity: 'critical', entity: 'env',
          finding: 'Coverage autosend is ON with a per-customer daily cap above 5',
          remediation: 'Lower COVERAGE_MAX_AUTOSENDS_PER_CUSTOMER_DAY (recommended ≤ 2).',
        });
      }
      if (process.env.COVERAGE_DRY_RUN === 'false' && Number(process.env.COVERAGE_AUTOSEND_TIMEOUT_H ?? 4) < 1) {
        findings.push({
          id: 'env-autosend-timeout', severity: 'high', entity: 'env',
          finding: 'Autosend timeout under 1 hour leaves almost no human review window',
          remediation: 'Raise COVERAGE_AUTOSEND_TIMEOUT_H (recommended ≥ 4).',
        });
      }
    }

    // 5. Guard hooks absent for message tools while autonomy features are on.
    const hooks = await (this.prisma as any).guard_hooks.findMany({ where: { is_active: true } }).catch(() => []);
    const hasMessageGuard = (hooks as any[]).some((h) => ['send_email', 'send_*', '*'].includes(h.tool_pattern));
    if (!hasMessageGuard && (process.env.ENABLE_COVERAGE_AUTOSEND === 'true' || process.env.ENABLE_DEV_PODS === 'true')) {
      findings.push({
        id: 'guard-missing', severity: 'medium', entity: 'guard_hooks',
        finding: 'No active guard hook covers outbound message tools while autonomous features are enabled',
        remediation: 'Add at least a blocked_recipient_domains or max_body_length hook on send_*.',
      });
    }

    // 6. Sensitivity drift: tools flipped to auto outside the reviewed set.
    // The reviewed set = the tiered-autonomy additions PLUS the tools that were
    // non-sensitive by original design (read-only BC/CRM reads, ticket ops).
    const expectedAuto = new Set([
      'devops_comment', 'devops_set_state', 'devops_link_workitem', 'github_dispatch_workflow',
      'bc_read_customer', 'bc_read_invoices', 'bc_read_balance', 'crm_read_record',
      'create_ticket', 'update_ticket',
    ]);
    for (const t of Object.values(TOOL_REGISTRY)) {
      const external = t.targets !== 'internal';
      if (external && !t.sensitive && !ALWAYS_APPROVE.has(t.name) && !expectedAuto.has(t.name)) {
        findings.push({
          id: `tool-auto-${t.name}`, severity: 'high', entity: t.name,
          finding: `External tool '${t.name}' executes WITHOUT approval and is outside the reviewed auto set`,
          remediation: 'Re-review its sensitivity in packages/shared/src/tool-intents.ts.',
        });
      }
    }

    const order: Finding['severity'][] = ['critical', 'high', 'medium', 'low'];
    findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    const score = Math.max(0, 100 - findings.reduce((n, f) => n + SEVERITY_WEIGHT[f.severity], 0));

    await this.audit.log({
      actorType: 'system', action: 'execute', entityType: 'security_audit',
      summary: `Security audit: score ${score}, ${findings.length} finding(s)`,
    });
    return { score, scannedAt: new Date().toISOString(), findings };
  }
}

@Module({
  imports: [AuditModule],
  controllers: [RulesController, GuardHooksController, SecurityAuditController],
})
export class GovernanceModule {}
