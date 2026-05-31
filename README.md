# DynamicsOps AI Resource Platform

Internal AI Resource Management Platform — incoming/outgoing business activities are received,
routed to specialized **AI Resources** (digital employees), executed, and escalated only when
needed. **Draft first, execute after approval.**

Architecture and full spec: see [the plan](#) and `docs/`. Hybrid backend — Node/TS owns API +
integrations + queue worker; Python/FastAPI owns agents + RAG. The Python agent is *pure
reasoning*: it holds no credentials and only **proposes** `tool_intents`; **Node executes** them
behind the approval gate.

## Quick start (zero external credentials)

```bash
cp .env.example .env
docker compose up --build          # postgres, redis, qdrant, agent, api, worker, web
# in another terminal, once api is healthy:
docker compose exec api node dist/prisma/seed.js   # or: pnpm db:seed
```

Then open <http://localhost:3000>, **dev-login** as `manager`.

## Smoke test — the vertical slice (§7 of the plan)

1. **Directory** → 10 AI Resources with provider/model badges.
2. **Inbox** → click **Trigger mock email** → an activity appears and routes to *AI Executive Assistant*.
3. Open the activity → see the AI **draft + reasoning + confidence** (stub LLM if no API key set).
4. **Approvals** → a pending `send_email` (+ calendar) intent → review → **Approve**.
5. The `MockEmailAdapter` logs the "send"; activity → `completed`.
6. **Audit** → full lineage `activities → agent_runs → tool_calls → approvals → audit_logs`.

## Layout

```
apps/web            Next.js 16 (App Router, RSC, Tailwind, shadcn/ui)
services/api        NestJS — persistence, RBAC, auth, adapters, gate, rules, queue producer
services/worker     BullMQ consumer — rules → agent → execute/approve → audit
services/agent      Python/FastAPI — LangGraph agents + multi-provider LLM + Qdrant RAG
packages/shared     shared TS types, AgentResult schema, tool registry, resource keys
infra/docker        per-service Dockerfiles
docs/               architecture, security, data-model, runbook
```

## Local dev (without Docker for app services)

```bash
pnpm install
docker compose up postgres redis qdrant -d
pnpm db:migrate && pnpm db:seed
pnpm dev            # runs api + worker + web via turbo; run agent separately
```

Optional: set `ANTHROPIC_API_KEY` or `AZURE_OPENAI_*` in `.env` and switch a resource's provider in
the Directory to get real LLM drafts. Everything else is identical.
