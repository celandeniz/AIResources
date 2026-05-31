# Build spec: 5 OpenClaw-inspired use cases + proposal→template miner

Repo: /Users/denizcelan/Documents/GitHub/AIResources (DynamicsOps AI Resource Platform).
Monorepo: pnpm + turbo. apps/web (Next.js 15 App Router, client JWT), services/api (NestJS, base path /api/v1),
services/worker (BullMQ), services/agent (FastAPI + LangGraph), packages/shared (zod + ResourceDefs + TOOL_REGISTRY),
packages/db (Prisma; shared client both Node services import). Multi-tenant: tenant guard via TENANT_MODELS in
services/api/src/common/tenant.ts; default workspace id 00000000-0000-0000-0000-0000000000ff.

Draft-first: the Python agent only PROPOSES tool_intents; the Node worker executes via the approval gate.
Stub fallback: with no LLM keys, services/agent/app/llm/stub_provider.py produces deterministic AgentResults
(it has a proactive branch keyed on "PROACTIVE OBJECTIVE" in the activity body). The 38 resources include 12
"business" roles (BUSINESS_DEFS) with proactive automations (automations table + worker scheduler in
services/worker/src/proactive.ts; queue 'proactive.run'; ENABLE_PROACTIVE=true). create_task and handoff are
executed in services/api/src/integrations/executor.service.ts (handoff spawns a pinned `proactive` activity).

Deploy: `docker compose build <svc> && docker compose up -d <svc>`. The api container runs `prisma db push` + seed on boot.
DB: user `dynops`, db `dynops`. Verify with `docker compose exec -T postgres psql -U dynops -d dynops -tA -c "..."`.
After ANY shared type change, if a Node build complains a new field is missing, the shared dist is stale:
`rm -rf packages/shared/dist packages/shared/tsconfig.tsbuildinfo && pnpm --filter @dynops/shared build`.
If web build fails with `util.getArg is not a function`: `rm -rf node_modules/.pnpm/source-map-js@* && pnpm install`.
If api build fails on a new enum/field: run `pnpm --filter @dynops/db exec prisma generate` first.

Build order to validate everything: shared → db(prisma generate) → api → worker → web; plus `python3 -m compileall -q services/agent/app`.

Existing relevant pieces:
- templates table + module (services/api/src/modules/templates/templates.controller.ts; /api/v1/templates GET/POST/PATCH/DELETE).
  process-activity.ts already injects the latest 5 templates as rag_hits into the agent request. UI: apps/web/app/(app)/templates/page.tsx.
- Knowledge module + agent RAG endpoints: agent has POST /v1/rag/ingest and /v1/rag/search (services/agent/app/rag/__init__.py, workspace-scoped Qdrant with a `must` workspace_id filter). UI: apps/web/app/(app)/knowledge/...
- GraphEmailAdapter (services/api/src/integrations/graph/graph-email.adapter.ts): has fetchHistorical(conn, sinceISO, cap) reading inbox; isActionable(from). graphConfigured() in graph-client.ts. Live graph_email integration row has config.mailbox.
- Digest: services/worker/src/weekly-digest.ts (writes digest_results rows), gated by ENABLE_DIGEST; worker index.ts has the timer pattern.
- automations table fields: resource_id, name, objective, cadence(daily|weekly|monthly|quarterly), handoff_to Json, sample_tasks Json, is_active, next_run_at, run_count, config Json. Seeded from ResourceDef.automations in packages/db/src/seed.ts.
- AI resource keys incl: ai_project_manager, ai_proposal_manager, ai_sales_assistant, ai_knowledge_manager,
  ai_product_manager, ai_marketing_manager, ai_social_content_manager, ai_business_development, ai_executive_assistant.
- TOOL_REGISTRY tools include: create_task, create_document, send_email, send_proposal, generate_quote, handoff, rag_search,
  devops_create_workitem, crm_update_record, send_teams_message, create_calendar_event. (Do NOT invent tool names.)

Keep draft-first: external/sensitive actions stay approval-gated. Internal artifacts (tasks, documents, templates, drafts) are fine to auto-create.

---

## WS1 — Meeting transcript → structured action items + tasks/ADO
We already route channel=document transcripts to ai_project_manager. Enhance so a transcript yields STRUCTURED action items
(what / owner / due) and auto-creates a task per item (+ optional ADO work item), plus a posted summary draft.
- Agent: in services/agent/app/llm/stub_provider.py, the ai_project_manager branch (and/or a transcript-detecting branch keyed on
  body/subject containing "transcript"/"meeting notes"/"minutes") should emit one create_task intent per detected action item
  (parse lines like "- [owner] action (due ...)" or bullet/numbered lists; if none parseable, create 1-3 sensible ones from the summary),
  and one devops_create_workitem if that tool is allowed. Draft = the structured summary (decisions + action table).
- Real models already follow the system prompt; ensure ai_project_manager's systemPrompt (packages/shared/src/resources.ts)
  explicitly instructs: produce a 5-bullet summary, then an action-item table (owner+due), then create_task per item.
- No schema change required (tasks table already supports this). Verify by ingesting a transcript activity and seeing tasks created.

## WS2 — Daily Executive Brief
Add a DAILY brief (the weekly digest is the model). 
- services/worker/src/daily-brief.ts: runDailyBrief() — for each active workspace compile last-24h: new activities, completed,
  escalations, pending approvals count, due/overdue tasks, and the latest proactive outputs. Write a digest_results row
  (kind 'daily_exec_brief', summary Json) AND create a notification (notifications table) titled "Daily Executive Brief"
  with the summary. Optionally a draft email if DIGEST_EMAIL_TO set (mock send via existing path — keep draft-first).
- Wire in services/worker/src/index.ts behind ENABLE_DAILY_BRIEF (default true in docker-compose worker env); run once ~20s after boot
  and then every 24h (setInterval), matching the existing digest timer pattern. Add DAILY_BRIEF env to docker-compose worker.
- Optional: surface on the dashboard or notifications page (already exists) — no new page strictly required.

## WS3 — Knowledge ingestion from URL
Let a user drop a URL → fetch → ingest into Qdrant RAG (workspace-scoped) → searchable.
- API: add POST /api/v1/knowledge/ingest-url { url, title? } (manager+). Fetch the URL server-side (Node fetch; strip HTML tags to text),
  chunk if large, then call the agent's POST {AGENT_URL}/v1/rag/ingest with { text, metadata: { workspace_id, title, source_url, type:'url', tags } }.
  Use x-internal-token like the worker's agent-client. Persist a knowledge_chunks/document row if that's the existing pattern (check knowledge module);
  otherwise rely on the agent RAG store. Return { ingested, chunks }.
- UI: in apps/web/app/(app)/knowledge/... add an "Add from URL" input + button that POSTs the URL and shows a toast with chunk count,
  then refreshes. Match existing page style.

## WS4 — Product Radar (proactive automations for ai_product_manager / ai_business_development)
No new external MCP. Implement as proactive automation templates + an agent flow that produces a "reality/opportunity" brief from
provided/RAG context (and notes that live web validation needs an external search connector — mark as a TODO capability).
- Add 1-2 automations to ai_product_manager and ai_business_development in packages/shared/src/business-resources.ts:
  e.g. "Weekly Market & Idea Radar" (objective: scan saved knowledge/RAG + recent activities for recurring customer pain points and
  emerging Dynamics/Power Platform opportunities; produce an opportunity brief; create_task for the top 3; handoff to ai_marketing_manager
  + ai_proposal_manager). These flow through the existing proactive engine. Reseed picks them up (automations upsert is idempotent).
- Stub: the generic proactive branch already emits create_task + handoff from the body, so this works zero-key.

## WS5 — Social media posts + new product announcements
Content engine producing draft social posts + product-announcement drafts (draft-first; nothing auto-published).
- Add proactive automations to ai_social_content_manager and ai_marketing_manager / ai_product_manager:
  "Weekly Social Content Batch" (objective: draft N LinkedIn/X posts for the week on Dynamics/Copilot/BC themes; create_document per post;
  handoff to ai_marketing_manager for review) and "Product Launch Announcement" (objective: when a new product/offer is ready, draft the
  announcement post + email + blog blurb; handoff to ai_marketing_manager & ai_business_development).
- Add a content template type: seed a few templates (type 'social_post' and 'product_announcement') in packages/db/src/seed.ts so drafts have structure.
- create_document is the artifact (already executed as a noted draft); send_email/send_proposal stay approval-gated.
- Optional UI: a simple "Content" filter on the templates page or a list of recent social_post documents — keep minimal.

## WS6 — Mine deniz@dynamicsops.com sent proposals → reusable templates
Find proposals/teklifler deniz@ sent to customers and turn them into reusable, parameterized proposal TEMPLATES in the templates table.
- GraphEmailAdapter: add fetchSentItems(conn, mailbox, sinceISO, cap) → GET /users/{mailbox}/mailFolders/sentitems/messages
  ?$orderby=sentDateTime desc&$top=50&$select=subject,bodyPreview,body,toRecipients,sentDateTime,internetMessageId, follow @odata.nextLink to cap.
  Add isProposal(subject, body): regex (?i)(proposal|teklif|quote|fiyat teklifi|SOW|statement of work|öneri|scope of work|engagement). 
  Treat a recipient as a customer if their domain is NOT dynamicsops.com.
- API: new module services/api/src/modules/proposal-mining/ — POST /api/v1/proposal-templates/mine { mailbox?, days?, cap? } (manager+):
  default mailbox 'deniz@dynamicsops.com', days 365, cap 50. Resolve the live graph_email integration (is_mock=false); if Graph not configured,
  400 with guidance. Fetch sent proposals → for each, call the agent (run as ai_proposal_manager) to GENERALIZE the proposal into a reusable
  template: replace customer/price/date specifics with placeholders like {{customer}}, {{scope}}, {{effort_days}}, {{price}}, {{date}}, keep the
  reusable structure/sections. Store each as a templates row (type 'proposal', name from subject (deduped), content = generalized template,
  metadata { source_message_id, customer, sent_at }). Skip duplicates by source_message_id. Return { scanned, created, skipped }.
  Reuse the agent via an internal call (mirror worker/agent-client runAgent, or call the agent /v1/agents/run with a proposal_manager request).
  Pure read of sent mail + writes ONLY to templates (no emails sent).
- GET /api/v1/proposal-templates → list templates where type='proposal' (or reuse templates list filtered by type).
- UI: on apps/web/app/(app)/templates/page.tsx add a "Mine sent proposals" button (manager) that POSTs the mine endpoint, shows progress/result toast,
  and lists the generated proposal templates (editable via existing template edit). These templates already feed proposal drafting via process-activity rag_hits.
- Note: requires the live Outlook/Graph connection for deniz@. If absent, the endpoint returns guidance; the UI shows it.

---

## Definition of done
- All 5 Node/Py builds compile; python compileall clean.
- docker compose rebuilt + up; seed runs clean (resource/automation counts grow as expected; new templates seeded).
- WS1: ingest a transcript → tasks created. WS2: daily_exec_brief digest_results + notification created on boot. WS3: ingest-url returns chunk count
  and search finds it. WS4/WS5: new automations present in `automations` table and produce drafts/tasks/handoffs on a proactive run.
  WS6: /proposal-templates/mine returns created>0 when Graph live (or clear guidance if not), and proposal-type templates appear.
- Do NOT commit/push. Report exactly what was built, build results, deploy result, and verification query outputs per WS.
