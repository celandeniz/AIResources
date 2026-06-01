import { Logger } from '@nestjs/common';
import type { IntegrationKind, ToolName } from '@dynops/shared';
import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';

// Meta WhatsApp Cloud API adapter.
// Outbound messages always require approval (send_whatsapp_message is sensitive).
// When WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are not set, the adapter
// operates in mock mode so the platform stays fully functional without credentials.

export function whatsappConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
}

export class WhatsAppAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'whatsapp';
  private readonly logger = new Logger('WhatsApp:adapter');

  async healthCheck(conn: ConnectionInfo) {
    const started = Date.now();
    if (!whatsappConfigured()) {
      return { ok: true, latencyMs: Date.now() - started, detail: `WhatsApp (mock) — set WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN to go live (${conn.name})` };
    }
    return { ok: true, latencyMs: Date.now() - started, detail: `WhatsApp Cloud API configured — phone_number_id=${process.env.WHATSAPP_PHONE_NUMBER_ID}` };
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    if (tool !== 'send_whatsapp_message') {
      return { ok: false, detail: `WhatsAppAdapter cannot execute ${tool}` };
    }

    const to = String(args.to ?? '').trim();
    if (!to) return { ok: false, detail: 'send_whatsapp_message requires args.to (recipient phone number in E.164)' };

    const body = String(args.body ?? args.message ?? args.content ?? '').trim();
    if (!body) return { ok: false, detail: 'send_whatsapp_message requires args.body' };

    // Mock path: no credentials set
    if (!whatsappConfigured()) {
      const externalId = `wa-mock-${Date.now()}`;
      this.logger.log(`MOCK send_whatsapp_message to ${to} via "${conn.name}"`);
      return {
        ok: true,
        external_id: externalId,
        detail: 'WhatsApp (mock) — set WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN to send for real',
        data: { simulated: true, to, body },
      };
    }

    // Real path: Meta WhatsApp Cloud API v21.0
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN!;
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.warn(`WhatsApp API error ${res.status}: ${text}`);
        return { ok: false, detail: `WhatsApp API ${res.status}: ${text.slice(0, 200)}` };
      }

      const data: any = await res.json();
      const messageId = data?.messages?.[0]?.id ?? `wa-${Date.now()}`;
      this.logger.log(`WhatsApp message sent to ${to}, id=${messageId}`);
      return { ok: true, external_id: messageId, detail: 'WhatsApp message sent' };
    } catch (e) {
      const detail = (e as Error).message;
      this.logger.error(`WhatsApp send failed: ${detail}`);
      return { ok: false, detail };
    }
  }
}

// Shared singleton (mirror of graphEmail / graphTeams pattern in executor.service.ts)
export const whatsAppAdapter = new WhatsAppAdapter();
