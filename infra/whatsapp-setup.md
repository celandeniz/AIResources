# WhatsApp Business Cloud API — Setup Guide

This document describes how to wire up the Meta WhatsApp Cloud API so the platform
can receive inbound WhatsApp messages and send replies after human approval.

---

## How it works

**Inbound (customer → platform)**
1. Customer sends a WhatsApp message to your business phone number.
2. Meta POSTs the payload to `POST /api/v1/whatsapp/webhook`.
3. The webhook parses each text message and calls `ActivitiesService.ingest()`.
4. The activity enters the normal pipeline: workflow routing → AI agent drafts a
   reply → the draft is held for human approval.

**Outbound (platform → customer, draft-first)**
1. An agent emits a `send_whatsapp_message` tool intent (always sensitive, risk: high).
2. The intent is **always** routed to the Human Approval Center — no auto-send.
3. Once a human approves, the executor calls the WhatsApp Cloud API.

---

## Prerequisites

- A Meta Business Account (business.facebook.com)
- A publicly accessible HTTPS host (e.g. ngrok for dev, your production API URL)

---

## Step 1 — Create a Meta App

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**.
2. Choose **Business** app type.
3. Add the **WhatsApp** product from the app dashboard.

---

## Step 2 — Get your credentials

| Item | Where to find it |
|---|---|
| **Phone Number ID** | WhatsApp → API Setup → your registered phone number |
| **Access Token** | WhatsApp → API Setup → generate a **permanent** System User token (not the temporary dev token) |

For production, use a System User token with `whatsapp_business_messaging` permission.

---

## Step 3 — Configure the webhook

In the Meta App dashboard → WhatsApp → Configuration → Webhook:

| Field | Value |
|---|---|
| **Callback URL** | `https://<your-public-host>/api/v1/whatsapp/webhook` |
| **Verify Token** | The value you put in `WHATSAPP_VERIFY_TOKEN` (choose any random string) |

Click **Verify and Save**, then subscribe to the `messages` field.

---

## Step 4 — Set environment variables

Add to your `.env` (never commit real values):

```
WHATSAPP_PHONE_NUMBER_ID=<your phone number id>
WHATSAPP_ACCESS_TOKEN=<your permanent access token>
WHATSAPP_VERIFY_TOKEN=<your chosen verify token>
WHATSAPP_APP_SECRET=<app secret from Meta App settings → Basic>
```

The `docker-compose.yml` api service already reads these with empty defaults so
the platform stays fully functional (mock mode) until they are set.

---

## Step 5 — Verify

1. Send a WhatsApp message to your business number.
2. Open the platform Inbox — a new `whatsapp` channel activity should appear.
3. The AI Support Agent will draft a reply. Approve it in the Human Approval Center
   to send it back to the customer.

---

## Security notes

- **Outbound always requires approval.** `send_whatsapp_message` is classified
  `sensitive: true, risk: 'high'` in the tool registry — it can never bypass the
  Human Approval Center regardless of agent confidence.
- **Webhook signature** (`X-Hub-Signature-256`): the platform performs a best-effort
  HMAC-SHA256 check. For strict enforcement, configure raw-body capture middleware
  so the HMAC is computed over the exact bytes Meta sent, not the re-serialised JSON.
- **Fail-closed**: if `WHATSAPP_VERIFY_TOKEN` is not set, both `GET` and `POST`
  `/api/v1/whatsapp/webhook` return 403. No hardcoded fallback token exists.

---

## Routing

By default, inbound WhatsApp activities are routed to **AI Support Agent** (priority 26
workflow rule). The Executive Assistant catches anything not matched by a higher-priority
rule (priority 1000 fallback).

To change routing, edit the `wf_core_routing` workflow rules in the platform UI or
in `packages/db/src/seed.ts`.
