import { Body, Controller, Get, Param, Post, Module, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { GraphEmailAdapter, isActionable } from '../../integrations/graph/graph-email.adapter';
import { discoverUserChannels, fetchChannelMessagesSince } from '../../integrations/graph/graph-teams.adapter';
import { graphConfigured } from '../../integrations/graph/graph-client';
import { fetchAssignedWorkItems, devopsConfigured } from '../../integrations/devops/devops.adapter';

@Controller('backtests')
class BacktestController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  list() {
    return this.prisma.backtests.findMany({ orderBy: { created_at: 'desc' }, take: 50 });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const bt = await this.prisma.backtests.findUnique({ where: { id } });
    if (!bt) throw new BadRequestException('not found');
    const items = await this.prisma.backtest_items.findMany({ where: { backtest_id: id }, orderBy: { received_at: 'desc' } });
    return { ...bt, items };
  }

  // Multi-source simulation: Outlook (real, ≥200), Teams + Azure DevOps (real when
  // a live connection / credentials exist). Pure dry-run; no live side effects.
  @Roles('manager')
  @Post()
  async create(
    @Body() body: { days?: number; cap?: number; label?: string; sources?: string[]; model?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const sources = body.sources?.length ? body.sources : ['outlook', 'teams', 'devops'];
    const days = Math.min(body.days ?? 30, 120);
    const cap = Math.min(body.cap ?? 200, 500);
    const from = new Date(Date.now() - days * 86400_000);
    const to = new Date();
    const notes: string[] = [];

    type Raw = { source: string; external_id?: string; subject?: string; body?: string; from?: string; received_at?: Date | null };
    const raw: Raw[] = [];
    let mailbox = '';

    // ── Outlook (real) ──
    if (sources.includes('outlook')) {
      if (!graphConfigured()) {
        notes.push('Outlook skipped: Microsoft Graph not configured.');
      } else {
        const conn = await this.prisma.integrations.findFirst({ where: { type: 'graph_email', is_mock: false } });
        if (!conn) notes.push('Outlook skipped: no live mailbox connection.');
        else {
          mailbox = (conn.config as any)?.mailbox ?? '';
          try {
            const mail = await new GraphEmailAdapter().fetchHistorical(
              { id: conn.id, type: conn.type, name: conn.name, config: (conn.config as any) ?? {}, isMock: conn.is_mock },
              from.toISOString(), cap * 4,
            );
            const actionable = mail.filter((m) => isActionable(m.from)).slice(0, cap);
            for (const m of actionable) raw.push({ source: 'outlook', external_id: m.internetMessageId || m.id, subject: m.subject, body: m.bodyPreview, from: m.from, received_at: m.receivedDateTime ? new Date(m.receivedDateTime) : null });
            notes.push(`Outlook: ${actionable.length} actionable of ${mail.length} scanned.`);
          } catch (e) {
            notes.push(`Outlook error: ${(e as Error).message}`);
          }
        }
      }
    }

    // ── Azure DevOps (real if ADO_PAT + ADO_ORGS) ──
    if (sources.includes('devops')) {
      if (!devopsConfigured()) {
        notes.push('Azure DevOps skipped: set ADO_ORGS + ADO_PAT to include work items assigned to you.');
      } else {
        try {
          const items = await fetchAssignedWorkItems(user.email, Math.floor(cap / 4));
          for (const w of items) raw.push({ source: 'devops', external_id: w.id, subject: `[${w.type}] ${w.title}`, body: `${w.state}: ${w.description}`, from: `${w.org} (Azure DevOps)`, received_at: new Date() });
          notes.push(`Azure DevOps: ${items.length} work items assigned to ${user.email}.`);
        } catch (e) {
          notes.push(`Azure DevOps error: ${(e as Error).message}`);
        }
      }
    }

    // ── Teams (auto-discover the user's teams/channels; needs Team.ReadBasic.All) ──
    if (sources.includes('teams')) {
      if (!graphConfigured()) {
        notes.push('Teams skipped: Microsoft Graph not configured.');
      } else {
        const userUpn = mailbox || user.email;
        try {
          const channels = await discoverUserChannels(userUpn, 30);
          const teamsCap = Math.max(50, Math.floor(cap / 3));
          let count = 0;
          for (const ch of channels) {
            if (count >= teamsCap) break;
            const msgs = await fetchChannelMessagesSince(ch, from.toISOString(), Math.ceil(teamsCap / Math.max(channels.length, 1)) + 5);
            for (const m of msgs) {
              if (count >= teamsCap) break;
              raw.push({ source: 'teams', external_id: m.id, subject: `${ch.channelName}: ${m.text.slice(0, 60)}`, body: m.text, from: `${m.from} · ${ch.teamName}`, received_at: new Date(m.createdDateTime) });
              count++;
            }
          }
          notes.push(`Teams: ${count} messages across ${channels.length} channels.`);
        } catch (e) {
          const msg = (e as Error).message;
          notes.push(msg.includes('403') ? 'Teams skipped: add Application permission Team.ReadBasic.All (+ admin consent).' : `Teams error: ${msg}`);
        }
      }
    }

    if (raw.length === 0) throw new BadRequestException('No items to simulate. ' + notes.join(' '));

    // model: 'auto' → each resource uses its own configured model (variety);
    // explicit model → override all; omitted → fast free model for large runs
    // (NIM light model when a key is set, else local gemma3). Overrides accept
    // a provider prefix ('nvidia/…'); bare names run on Ollama.
    const FAST = process.env.NVIDIA_API_KEY ? 'nvidia/meta/llama-3.1-8b-instruct' : 'gemma3';
    const modelOverride =
      body.model === 'auto' ? undefined : (body.model ?? (raw.length >= 60 ? FAST : undefined));

    const bt = await this.prisma.backtests.create({
      data: {
        label: body.label ?? `Backtest · ${sources.join('+')} · ${days}d · ${raw.length} items`,
        mailbox,
        from_date: from,
        to_date: to,
        status: 'pending',
        total: raw.length,
        config: { sources, model_override: modelOverride ?? null, days, cap, notes } as any,
        created_by: user.id,
      },
    });
    for (const r of raw) {
      await this.prisma.backtest_items.create({
        data: { backtest_id: bt.id, source: r.source, external_id: r.external_id ?? null, subject: r.subject ?? null, body: r.body ?? null, from_address: r.from ?? null, received_at: r.received_at ?? null },
      });
    }
    await this.queue.enqueueBacktest(bt.id);
    return { id: bt.id, total: raw.length, notes };
  }
}

@Module({ controllers: [BacktestController] })
export class BacktestModule {}
