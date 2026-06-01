import { Controller, Get, Post, Query, Body, Headers, Req, Res, Logger, Module } from '@nestjs/common';
import type { Response } from 'express';
import type { RawBodyRequest } from '@nestjs/common';
import * as crypto from 'crypto';
import { Public } from '../../auth/decorators';
import { ActivitiesService } from '../inbox/activities.service';
import { InboxModule } from '../inbox/inbox.module';
import { PrismaService } from '../../prisma/prisma.service';
import { tenantStore } from '../../common/tenant';

const DEFAULT_WS = '00000000-0000-0000-0000-0000000000ff';

// ── Meta WhatsApp Cloud API webhook ──────────────────────────────────────────
// Receives inbound WhatsApp messages and turns them into activities via the
// normal ingest pipeline (draft-first, approval-gated).
//
// FAIL-CLOSED: all endpoints return 403/disabled unless WHATSAPP_VERIFY_TOKEN
// is set. No hardcoded defaults — a missing token keeps the webhook inactive.
//
// Env vars (all optional → mock/disabled):
//   WHATSAPP_VERIFY_TOKEN  — shared secret for Meta webhook verification handshake
//   WHATSAPP_APP_SECRET    — app secret for X-Hub-Signature-256 validation
//   WHATSAPP_PHONE_NUMBER_ID — phone number id for the outbound adapter
//   WHATSAPP_ACCESS_TOKEN  — bearer token for the outbound adapter
//
// Outbound: send_whatsapp_message is sensitive (risk: high) → ALWAYS routed to
// Human Approval Center before execution. See infra/whatsapp-setup.md.

@Controller('whatsapp')
class WhatsAppController {
  private readonly logger = new Logger('WhatsApp:webhook');

  constructor(
    private readonly activities: ActivitiesService,
    private readonly prisma: PrismaService,
  ) {}

  // Inbound webhooks carry no workspace context (Meta won't send x-workspace), so
  // resolve the WhatsApp integration's workspace (fallback: the primary workspace)
  // and stamp ingested activities with it — otherwise routing finds no rules.
  private async resolveWorkspace(): Promise<string> {
    try {
      const conn = await this.prisma.integrations.findFirst({ where: { type: 'whatsapp' as any } });
      return (conn?.workspace_id as string) ?? DEFAULT_WS;
    } catch {
      return DEFAULT_WS;
    }
  }

  // ── Meta verification handshake (GET /whatsapp/webhook) ────────────────────
  // Meta sends hub.mode=subscribe, hub.verify_token, hub.challenge.
  // Respond with the raw challenge value to confirm ownership.
  @Public()
  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!expected) {
      this.logger.warn('WhatsApp webhook disabled: set WHATSAPP_VERIFY_TOKEN to enable.');
      return res.status(403).json({ error: 'WhatsApp webhook disabled' });
    }
    if (mode === 'subscribe' && token === expected) {
      this.logger.log('WhatsApp webhook verified');
      return res.status(200).send(challenge);
    }
    this.logger.warn(`WhatsApp webhook verification failed: mode=${mode}`);
    return res.status(403).json({ error: 'verification failed' });
  }

  // ── Inbound messages (POST /whatsapp/webhook) ──────────────────────────────
  // Meta posts the full notification payload. We parse entry[].changes[].value
  // for text messages and ingest each as a new activity.
  // IMPORTANT: Meta requires a 200 response within ~5 s. We return 200 immediately
  // and run ingestion best-effort (errors are swallowed so Meta doesn't retry).
  @Public()
  @Post('webhook')
  async receive(
    @Req() req: RawBodyRequest<import('express').Request>,
    @Body() body: any,
    @Headers('x-hub-signature-256') sig: string | undefined,
    @Res() res: Response,
  ) {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verifyToken) {
      this.logger.warn('WhatsApp webhook disabled: ignoring POST (WHATSAPP_VERIFY_TOKEN not set).');
      return res.status(403).json({ error: 'WhatsApp webhook disabled' });
    }

    // Signature enforcement. When WHATSAPP_APP_SECRET is set (production posture),
    // the X-Hub-Signature-256 HMAC over the RAW request bytes MUST be present and
    // valid (constant-time compare) — otherwise reject and do NOT process. This
    // prevents forged inbound messages on this @Public() endpoint. When no app
    // secret is configured the webhook runs UNSIGNED (local dev only).
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    if (appSecret) {
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
      const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
      const provided = sig ?? '';
      const ok =
        provided.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      if (!ok) {
        this.logger.warn('WhatsApp webhook: invalid/missing x-hub-signature-256 — rejected.');
        return res.status(401).json({ error: 'invalid signature' });
      }
    } else {
      this.logger.warn('WhatsApp webhook running UNSIGNED (WHATSAPP_APP_SECRET not set) — dev only; set it in production.');
    }

    // Respond 200 immediately so Meta doesn't retry.
    res.status(200).json({ ok: true });

    // Process payload asynchronously (best-effort).
    this.processPayload(body).catch((e) =>
      this.logger.error(`WhatsApp payload processing error: ${(e as Error).message}`),
    );
  }

  private async processPayload(payload: any): Promise<void> {
    // Meta payload shape:
    // { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [], contacts: [] } }] }] }
    if (!payload?.entry || !Array.isArray(payload.entry)) return;
    const workspaceId = await this.resolveWorkspace();
    return tenantStore.run({ workspaceId }, () => this.ingestEntries(payload));
  }

  private async ingestEntries(payload: any): Promise<void> {
    for (const entry of payload.entry) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value?.messages || !Array.isArray(value.messages)) continue;

        // Build a phone→name lookup from the contacts array (may be absent).
        const contactNames: Record<string, string> = {};
        for (const c of value.contacts ?? []) {
          const wa_id: string = c?.wa_id ?? '';
          const name: string = c?.profile?.name ?? '';
          if (wa_id && name) contactNames[wa_id] = name;
        }

        for (const msg of value.messages) {
          if (msg?.type !== 'text') continue; // only handle text messages

          const from: string = String(msg.from ?? '').trim(); // wa_id (phone in E.164)
          const externalId: string = String(msg.id ?? '').trim();
          const textBody: string = String(msg?.text?.body ?? '').trim();
          if (!from || !textBody) continue;

          const contactName = contactNames[from];
          const fromLabel = contactName ? `${contactName} (${from})` : from;
          const subject = textBody.slice(0, 120);

          try {
            await this.activities.ingest({
              channel: 'whatsapp',
              external_id: externalId || undefined,
              from: fromLabel,
              subject,
              body: textBody,
              conversation_id: from, // group by phone number
            });
            this.logger.log(`Ingested WhatsApp message from ${fromLabel}`);
          } catch (e) {
            this.logger.error(`Failed to ingest WhatsApp message id=${externalId}: ${(e as Error).message}`);
          }
        }
      }
    }
  }
}

@Module({
  imports: [InboxModule],
  controllers: [WhatsAppController],
})
export class WhatsAppModule {}
