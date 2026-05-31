import { BadRequestException, Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { AgentRunRequest } from '@dynops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';
import { GraphEmailAdapter, customerRecipients, isProposal } from '../../integrations/graph/graph-email.adapter';
import { graphConfigured } from '../../integrations/graph/graph-client';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

function stripHtml(input: string): string {
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function templateName(subject: string, customer: string, sentAt?: string): string {
  const clean = (subject || 'Proposal').replace(/^(re|fw|fwd):\s*/i, '').replace(/\s+/g, ' ').trim();
  const date = sentAt ? sentAt.slice(0, 10) : 'undated';
  return `${clean} (${customer || 'customer'} · ${date})`.slice(0, 240);
}

async function runProposalAgent(req: AgentRunRequest) {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

@Controller('proposal-templates')
class ProposalMiningController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return (this.prisma as any).templates.findMany({
      where: { type: 'proposal' },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  @Roles('manager')
  @Post('mine')
  async mine(@Body() body: { mailbox?: string; days?: number; cap?: number }, @CurrentUser() user: AuthUser) {
    if (!graphConfigured()) {
      throw new BadRequestException('Microsoft Graph is not configured. Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, and GRAPH_CLIENT_SECRET, then connect a live graph_email integration.');
    }
    const conn = await this.prisma.integrations.findFirst({ where: { type: 'graph_email', is_mock: false } });
    if (!conn) throw new BadRequestException('No live graph_email integration found. Connect Outlook/Graph for deniz@dynamicsops.com first.');

    const mailbox = body.mailbox || 'deniz@dynamicsops.com';
    const days = Math.min(Math.max(body.days ?? 365, 1), 3650);
    const cap = Math.min(Math.max(body.cap ?? 50, 1), 200);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const adapter = new GraphEmailAdapter();
    const sent = await adapter.fetchSentItems(
      { id: conn.id, type: conn.type, name: conn.name, config: (conn.config as any) ?? {}, isMock: conn.is_mock },
      mailbox,
      since,
      cap,
    );

    const proposalManager = await this.prisma.ai_resources.findUnique({ where: { key: 'ai_proposal_manager' } });
    if (!proposalManager) throw new BadRequestException('ai_proposal_manager resource is missing.');

    const existing = await (this.prisma as any).templates.findMany({
      where: { type: 'proposal' },
      select: { metadata: true },
      take: 1000,
    });
    const existingSourceIds = new Set(existing.map((t: any) => t.metadata?.source_message_id).filter(Boolean));

    let scanned = 0;
    let created = 0;
    let skipped = 0;
    const createdTemplates: any[] = [];
    for (const mail of sent) {
      scanned++;
      const recipients = customerRecipients(mail.toRecipients);
      const plainBody = stripHtml(mail.body || mail.bodyPreview || '');
      const sourceId = mail.internetMessageId || mail.id;
      if (!recipients.length || !isProposal(mail.subject, plainBody) || existingSourceIds.has(sourceId)) {
        skipped++;
        continue;
      }

      const customer = recipients[0].split('@')[1] ?? recipients[0];
      const req: AgentRunRequest = {
        run_id: `proposal-mine-${Date.now()}-${created}`,
        workspace_id: currentWorkspaceId() ?? undefined,
        ai_resource: {
          key: proposalManager.key,
          name: proposalManager.name,
          system_prompt: proposalManager.system_prompt,
          provider: proposalManager.llm_provider,
          model: proposalManager.llm_model,
          temperature: Number(proposalManager.temperature),
          tools: (proposalManager.allowed_tools as string[]) ?? [],
          confidence_threshold: Number(proposalManager.confidence_threshold),
        },
        activity: {
          id: sourceId,
          channel: 'email',
          subject: `GENERALIZE proposal template: ${mail.subject || 'sent proposal'}`,
          body: `GENERALIZE this sent customer proposal into a reusable parameterized proposal template. Replace customer, dates, prices, effort, scope specifics, and named contacts with placeholders like {{customer}}, {{scope}}, {{effort_days}}, {{price}}, and {{date}}.\n\nSubject: ${mail.subject || ''}\nSent at: ${mail.sentDateTime || ''}\nRecipients: ${recipients.join(', ')}\n\n${plainBody}`,
          priority: 'normal',
          customer: { id: customer, name: customer, tier: null },
          received_at: mail.sentDateTime,
        },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      };
      const agent = await runProposalAgent(req);
      const content = agent?.draft?.content || plainBody;
      const row = await (this.prisma as any).templates.create({
        data: {
          workspace_id: currentWorkspaceId() ?? undefined,
          name: templateName(mail.subject || 'Proposal', customer, mail.sentDateTime),
          type: 'proposal',
          content,
          created_by: user.id,
          metadata: { source_message_id: sourceId, customer, sent_at: mail.sentDateTime, mailbox, recipients },
        },
      });
      existingSourceIds.add(sourceId);
      created++;
      createdTemplates.push(row);
    }
    return { scanned, created, skipped, templates: createdTemplates };
  }
}

@Module({ controllers: [ProposalMiningController] })
export class ProposalMiningModule {}
