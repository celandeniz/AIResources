import { Body, Controller, Headers, Module, Post, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { Public } from '../../auth/decorators';
import { tenantStore } from '../../common/tenant';

// ── Microsoft Teams front-end (Phase 3) ──────────────────────────────────────
// A minimal Bot Framework messaging endpoint: chat a resource, get a daily brief,
// launch a Mission Pod, and approve actions via Adaptive Cards — inside Teams.
//
// AUTH: these endpoints are @Public() (a bot is not a logged-in platform user).
// In dev they are gated by a shared secret (x-teams-secret == TEAMS_BOT_SECRET).
// PRODUCTION: put this behind real Bot Framework JWT validation (botbuilder's
// CloudAdapter validates the Authorization bearer issued by the Bot Connector
// using TEAMS_BOT_APP_ID/PASSWORD). The bot stays INACTIVE until those are set.
// See infra/teams-bot-setup.md for the Azure Bot registration steps.

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const API_SELF = `http://localhost:${process.env.API_PORT ?? 4000}/api/v1`;
const DEFAULT_WS = '00000000-0000-0000-0000-0000000000ff';

type Activity = { type?: string; text?: string; value?: any; from?: any; conversation?: any };

function msg(text: string, card?: any): Activity {
  const a: Activity = { type: 'message', text };
  if (card) (a as any).attachments = [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }];
  return a;
}

function approvalCard(ap: any): any {
  return {
    type: 'AdaptiveCard', version: '1.4', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `Approval: ${ap.action}` },
      { type: 'TextBlock', wrap: true, text: ap.reason ? `Reason: ${ap.reason}` : 'Sensitive action pending review.' },
      { type: 'FactSet', facts: [
        { title: 'Risk', value: String(ap.risk_level ?? 'medium') },
        { title: 'Amount', value: ap.amount != null ? String(ap.amount) : '—' },
      ] },
    ],
    actions: [
      { type: 'Action.Submit', title: '✅ Approve', data: { action: 'approve', approvalId: ap.id } },
      { type: 'Action.Submit', title: '❌ Reject', data: { action: 'reject', approvalId: ap.id } },
    ],
  };
}

@Controller('teams')
class TeamsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  private auth(secret?: string) {
    // FAIL-CLOSED. The bot is DISABLED unless an operator explicitly sets a secret
    // (no hardcoded default — a committed default would be a public credential on
    // these @Public() endpoints, which can approve/reject actions). When a real Bot
    // Framework App ID is configured, production MUST validate the Bot Connector JWT
    // here (botbuilder CloudAdapter) — the shared-secret path is dev-only.
    if (process.env.TEAMS_BOT_APP_ID) {
      throw new UnauthorizedException('Teams bot: Bot Framework JWT validation not yet wired — see infra/teams-bot-setup.md.');
    }
    const expected = process.env.TEAMS_BOT_SECRET;
    if (!expected) throw new UnauthorizedException('Teams bot disabled: set TEAMS_BOT_SECRET to enable the dev gate.');
    if (!secret || secret !== expected) throw new UnauthorizedException('invalid teams secret');
  }

  @Public()
  @Post('messages')
  async messages(@Body() activity: Activity, @Headers('x-teams-secret') secret?: string) {
    this.auth(secret);
    // Adaptive Card submit (approve/reject) arrives as a message with `value`.
    if (activity?.value?.action) return this.action(activity.value, secret);

    const text = (activity?.text ?? '').trim().replace(/<at>.*?<\/at>/g, '').trim();
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');

    return tenantStore.run({ workspaceId: DEFAULT_WS }, async () => {
      switch ((cmd || '/help').toLowerCase()) {
        case '/help':
          return msg('Commands: `/ask <resource> <question>`, `/brief`, `/mission <goal>`, `/status`.');
        case '/status': {
          const [pending, missions] = await Promise.all([
            this.prisma.approvals.count({ where: { status: 'pending' } }),
            (this.prisma as any).missions.count({ where: { status: 'running' } }),
          ]);
          return msg(`📊 ${pending} approval(s) pending · ${missions} mission(s) running.`);
        }
        case '/brief': {
          const since = new Date(Date.now() - 86400_000);
          const [done, escalated, pending] = await Promise.all([
            this.prisma.activities.count({ where: { status: 'completed', created_at: { gte: since } } }),
            this.prisma.activities.count({ where: { status: 'escalated', created_at: { gte: since } } }),
            this.prisma.approvals.count({ where: { status: 'pending' } }),
          ]);
          return msg(`🗞️ Last 24h: ${done} completed · ${escalated} escalated · ${pending} approvals waiting.`);
        }
        case '/mission': {
          if (!arg) return msg('Usage: `/mission <goal>`');
          const m = await (this.prisma as any).missions.create({ data: { title: arg.slice(0, 240), goal: arg, status: 'planning' } });
          await this.queue.enqueueMission(m.id);
          return msg(`🎯 Mission launched: "${arg}". The team is planning now.`);
        }
        case '/ask': {
          const [key, ...q] = rest;
          const question = q.join(' ');
          if (!key || !question) return msg('Usage: `/ask <resource-key-or-name> <question>`');
          const resource = await this.prisma.ai_resources.findFirst({ where: { OR: [{ key }, { name: { contains: key, mode: 'insensitive' } }], status: 'active' } });
          if (!resource) return msg(`No active resource matching "${key}".`);
          const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: JSON.stringify({
              run_id: `teams-${Date.now()}`, workspace_id: DEFAULT_WS,
              ai_resource: { key: resource.key, name: resource.name, system_prompt: resource.system_prompt, provider: resource.llm_provider, model: resource.llm_model, temperature: Number(resource.temperature), tools: [], confidence_threshold: Number(resource.confidence_threshold) },
              activity: { id: `teams-${Date.now()}`, channel: 'manual', subject: 'Teams question', body: question, priority: 'normal' },
              context: { thread: [], rag_hints: [], rag_hits: [] }, options: { max_tool_intents: 0 },
            }),
          });
          const data: any = await res.json().catch(() => ({}));
          return msg(`**${resource.name}**: ${data?.draft?.content ?? '(no answer)'}`);
        }
        default:
          return msg('Unknown command. Try `/help`.');
      }
    });
  }

  @Public()
  @Post('action')
  async action(@Body() body: { action: string; approvalId: string }, @Headers('x-teams-secret') secret?: string) {
    this.auth(secret);
    if (!body?.approvalId) return msg('Missing approvalId.');
    const route = body.action === 'approve' ? 'approve' : 'reject';
    // Entitlement: only act on an approval that belongs to THIS bot's workspace —
    // don't blindly trust the body's approvalId (the bot operates on one workspace).
    const ok = await tenantStore.run({ workspaceId: DEFAULT_WS }, async () => {
      const ap = await this.prisma.approvals.findFirst({ where: { id: body.approvalId } });
      return !!ap;
    });
    if (!ok) throw new UnauthorizedException('approval not found in this workspace');
    const res = await fetch(`${API_SELF}/approvals/${body.approvalId}/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    });
    return msg(res.ok ? `✅ Approval ${route}d.` : `Could not ${route} (status ${res.status}).`);
  }
}

@Module({ controllers: [TeamsController] })
export class TeamsModule {}

export { approvalCard };
