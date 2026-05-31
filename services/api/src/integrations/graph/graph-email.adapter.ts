import { Logger } from '@nestjs/common';
import type { IntegrationKind, ToolName } from '@dynops/shared';
import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';
import { graphFetch, getGraphToken } from './graph-client';

// Real Outlook connector via Microsoft Graph (app-only).
// - execute(send_email) → POST /users/{mailbox}/sendMail   (needs Mail.Send)
// - pollNewMessages()   → /users/{mailbox}/mailFolders/inbox/messages/delta  (needs Mail.Read)
export class GraphEmailAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'email';
  private readonly logger = new Logger('Graph:email');

  private mailbox(conn: ConnectionInfo): string {
    const m = (conn.config.mailbox as string) || (conn.config.external_ref as string);
    if (!m) throw new Error(`integration "${conn.name}" has no config.mailbox`);
    return m;
  }

  async healthCheck(conn: ConnectionInfo) {
    const started = Date.now();
    const mailbox = this.mailbox(conn);
    try {
      await getGraphToken();
      // Probe the mailbox itself (covered by Mail.Read) — NOT the directory user
      // object (which would require User.Read.All).
      const f = await graphFetch(`/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=displayName,totalItemCount`);
      return { ok: true, latencyMs: Date.now() - started, detail: `Graph OK — ${mailbox} inbox (${f.totalItemCount ?? '?'} items)` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    if (tool !== 'send_email' && tool !== 'send_proposal') {
      return { ok: false, detail: `GraphEmailAdapter cannot execute ${tool}` };
    }
    const mailbox = this.mailbox(conn);
    const to = ((args.to as string[]) ?? (args.recipients as string[]) ?? []).filter(Boolean);
    const message = {
      subject: (args.subject as string) ?? '(no subject)',
      body: { contentType: 'Text', content: (args.body as string) ?? (args.content as string) ?? '' },
      toRecipients: to.map((address) => ({ emailAddress: { address } })),
    };
    await graphFetch(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({ message, saveToSentItems: true }),
    });
    this.logger.log(`Sent mail from ${mailbox} to ${to.join(', ')}`);
    return { ok: true, external_id: `graph-mail-${Date.now()}`, detail: `Sent from ${mailbox} to ${to.join(', ')}` };
  }

  // Timestamp-watermark poll (start-from-now, bounded). Returns mail received
  // AFTER `config.mail_since`, plus the new watermark to persist. First run with
  // no watermark baselines at "now" and ingests nothing (skips the backlog).
  async pollNewMessages(conn: ConnectionInfo): Promise<{ messages: GraphMail[]; watermark: string; baseline: boolean }> {
    const mailbox = this.mailbox(conn);
    const since = conn.config.mail_since as string | undefined;
    const now = new Date().toISOString();
    if (!since) {
      return { messages: [], watermark: now, baseline: true };
    }
    const filter = encodeURIComponent(`receivedDateTime gt ${since}`);
    const url =
      `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$filter=${filter}&$orderby=receivedDateTime%20desc&$top=25` +
      `&$select=subject,bodyPreview,from,receivedDateTime,internetMessageId`;
    const page = await graphFetch(url);
    const messages: GraphMail[] = [];
    let watermark = since;
    for (const m of page.value ?? []) {
      messages.push({
        id: m.id,
        internetMessageId: m.internetMessageId,
        subject: m.subject,
        bodyPreview: m.bodyPreview,
        from: m.from?.emailAddress?.address,
        receivedDateTime: m.receivedDateTime,
      });
      if (m.receivedDateTime && m.receivedDateTime > watermark) watermark = m.receivedDateTime;
    }
    return { messages, watermark, baseline: false };
  }

  // Read-only historical fetch for backtesting: messages received since `sinceISO`,
  // newest first, paginated up to `cap`. Does NOT touch the watermark/poller.
  async fetchHistorical(conn: ConnectionInfo, sinceISO: string, cap = 25): Promise<GraphMail[]> {
    const mailbox = this.mailbox(conn);
    const filter = encodeURIComponent(`receivedDateTime ge ${sinceISO}`);
    let url: string | undefined =
      `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
      `?$filter=${filter}&$orderby=receivedDateTime%20desc&$top=50` +
      `&$select=subject,bodyPreview,from,receivedDateTime,internetMessageId`;
    const out: GraphMail[] = [];
    for (let guard = 0; guard < 20 && url && out.length < cap; guard++) {
      const page = await graphFetch(url);
      for (const m of page.value ?? []) {
        out.push({
          id: m.id,
          internetMessageId: m.internetMessageId,
          subject: m.subject,
          bodyPreview: m.bodyPreview,
          from: m.from?.emailAddress?.address,
          receivedDateTime: m.receivedDateTime,
        });
        if (out.length >= cap) break;
      }
      url = page['@odata.nextLink'];
    }
    return out;
  }

  async fetchSentItems(conn: ConnectionInfo, mailbox: string, sinceISO: string, cap = 50): Promise<GraphSentMail[]> {
    const targetMailbox = mailbox || this.mailbox(conn);
    const filter = encodeURIComponent(`sentDateTime ge ${sinceISO}`);
    let url: string | undefined =
      `/users/${encodeURIComponent(targetMailbox)}/mailFolders/sentitems/messages` +
      `?$filter=${filter}&$orderby=sentDateTime%20desc&$top=50` +
      `&$select=subject,bodyPreview,body,toRecipients,sentDateTime,internetMessageId`;
    const out: GraphSentMail[] = [];
    for (let guard = 0; guard < 20 && url && out.length < cap; guard++) {
      const page = await graphFetch(url);
      for (const m of page.value ?? []) {
        out.push({
          id: m.id,
          internetMessageId: m.internetMessageId,
          subject: m.subject,
          bodyPreview: m.bodyPreview,
          body: m.body?.content,
          toRecipients: (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean),
          sentDateTime: m.sentDateTime,
        });
        if (out.length >= cap) break;
      }
      url = page['@odata.nextLink'];
    }
    return out;
  }
}

// Heuristic: exclude automated / no-reply / newsletter senders from a backtest.
export function isActionable(from?: string | null): boolean {
  if (!from) return false;
  return !/no-?reply|newsletter|notifications?|mailer|donotreply|do-not-reply|updates?@|info@|bounce|automated|noreply|digest|alerts?@/i.test(from);
}

export function isProposal(subject?: string | null, body?: string | null): boolean {
  return /proposal|teklif|quote|fiyat teklifi|SOW|statement of work|öneri|oneri|scope of work|engagement/i.test(`${subject ?? ''}\n${body ?? ''}`);
}

export function customerRecipients(recipients: string[] = []): string[] {
  return recipients.filter((r) => {
    const domain = r.split('@')[1]?.toLowerCase();
    return domain && domain !== 'dynamicsops.com';
  });
}

export interface GraphMail {
  id: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: string;
  receivedDateTime?: string;
}

export interface GraphSentMail {
  id: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: string;
  toRecipients: string[];
  sentDateTime?: string;
}
