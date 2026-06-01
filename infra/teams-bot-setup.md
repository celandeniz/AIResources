# Microsoft Teams bot — setup (Phase 3)

The platform exposes a Teams bot at `POST /api/v1/teams/messages` (+ `/teams/action` for Adaptive
Card Approve/Reject). Commands: `/ask <resource> <question>`, `/brief`, `/mission <goal>`, `/status`,
`/help`. It is **inactive until you register an Azure Bot** and point it at this endpoint.

**Fail-closed:** the bot is **disabled by default**. With no `TEAMS_BOT_SECRET` set, every `/teams/*`
call is rejected (401). For local testing set a random `TEAMS_BOT_SECRET` in `.env` and pass it as the
`x-teams-secret` header — this dev gate is for curl/testing only, never for real Teams traffic. There is
**no hardcoded default secret**. When `TEAMS_BOT_APP_ID` is set, the dev gate is refused outright until
Bot Framework JWT validation is wired (below).

## What's implemented vs. what you provide
- **Implemented (code):** the messaging endpoint, command routing, agent Q&A, mission launch, daily
  brief / status, and Adaptive Card approvals wired to the existing Approvals API.
- **You provide (Azure, one-time):** an Azure Bot registration (App ID + password) and a public HTTPS
  endpoint. Then production auth (Bot Framework JWT validation via botbuilder's CloudAdapter) should be
  switched on in `services/api/src/modules/teams/teams.controller.ts` (replace the dev-secret gate).

## Steps
1. **Azure Bot resource** → Azure Portal → create *Azure Bot* (multi-tenant). Note the **Microsoft App
   ID**; create a client secret (**password**).
2. **Messaging endpoint** → set it to `https://<your-public-host>/api/v1/teams/messages`. For local dev
   use a tunnel: `az bot ... ` or `devtunnel host -p 4000` / `ngrok http 4000`, then use that HTTPS URL.
3. **Teams channel** → in the Azure Bot, enable the *Microsoft Teams* channel.
4. **Env** → put the values in `.env`:
   ```
   TEAMS_BOT_APP_ID=<app id>
   TEAMS_BOT_APP_PASSWORD=<client secret>
   ```
   (`docker compose up -d api` to apply.) With `TEAMS_BOT_APP_ID` set, the controller refuses
   unauthenticated calls — finish the botbuilder JWT validation before exposing it publicly.
5. **Manifest** → create a Teams app manifest referencing the App ID, sideload it (or publish to your
   org), and chat the bot.

## Local smoke test (dev secret, no Azure)
```bash
curl -s -X POST localhost:4000/api/v1/teams/messages \
  -H 'content-type: application/json' -H 'x-teams-secret: dev-teams-secret' \
  -d '{"type":"message","text":"/status"}'
```

## Production hardening (before real traffic)
- Add `botbuilder` (`CloudAdapter` + `ConfigurationBotFrameworkAuthentication`) and validate the
  `Authorization` bearer the Bot Connector sends; drop the dev-secret gate.
- Store conversation references to support **proactive** messages (push approval cards to a channel
  when an approval is created), and map a Teams team → a platform workspace (currently defaults to the
  primary workspace).
