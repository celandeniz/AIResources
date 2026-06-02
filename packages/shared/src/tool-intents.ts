import { z } from 'zod';
import type { RiskLevel } from './enums';

// ─────────────────────────────────────────────────────────────────────────────
// Authoritative tool registry (Node side of truth).
//
// The Python agent may PROPOSE any of these as tool_intents, but Node holds the
// authoritative classification: which tools are sensitive (always approval),
// which integration type they target, and their default risk level. The agent's
// own `sensitive` flag is advisory only — Node re-derives it from this registry.
// ─────────────────────────────────────────────────────────────────────────────

export type ToolName =
  // executive assistant / general
  | 'send_email'
  | 'send_teams_message'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'create_task'
  | 'rag_search'
  | 'post_message'
  // azure devops (multi-org)
  | 'devops_create_workitem'
  | 'devops_update_workitem'
  | 'devops_comment'
  // github (multi-repo)
  | 'github_create_issue'
  | 'github_comment'
  | 'github_review_pr'
  // opsconnect (portal + hub)
  | 'opsconnect_create_project'
  | 'opsconnect_create_task'
  | 'opsconnect_update_status'
  | 'opsconnect_comment'
  // business central (per company)
  | 'bc_read_customer'
  | 'bc_read_invoices'
  | 'bc_read_balance'
  | 'bc_create_invoice'
  | 'bc_post_payment'
  // crm / proposals / support
  | 'crm_read_record'
  | 'crm_update_record'
  | 'create_ticket'
  | 'update_ticket'
  | 'create_document'
  | 'generate_quote'
  | 'send_proposal'
  | 'handoff'
  | 'remember'
  | 'run_report'
  | 'make_chart'
  | 'send_whatsapp_message'
  | 'bc_create_sales_order';

export type IntegrationKind =
  | 'email'
  | 'teams'
  | 'calendar'
  | 'devops'
  | 'github'
  | 'opsconnect'
  | 'business_central'
  | 'crm'
  | 'whatsapp'
  | 'internal';

export interface ToolDef {
  name: ToolName;
  sensitive: boolean; // true => ALWAYS routed to Human Approval Center
  risk: RiskLevel;
  targets: IntegrationKind; // which connection kind the executor routes to
  monetary?: boolean; // value-bearing => also bounded by approval_limit
  description: string;
}

export const TOOL_REGISTRY: Record<ToolName, ToolDef> = {
  send_email: { name: 'send_email', sensitive: true, risk: 'medium', targets: 'email', description: 'Send an outbound email.' },
  send_teams_message: { name: 'send_teams_message', sensitive: true, risk: 'medium', targets: 'teams', description: 'Post a Teams message.' },
  create_calendar_event: { name: 'create_calendar_event', sensitive: true, risk: 'low', targets: 'calendar', description: 'Create a calendar event.' },
  update_calendar_event: { name: 'update_calendar_event', sensitive: true, risk: 'low', targets: 'calendar', description: 'Reschedule/cancel a calendar event.' },
  create_task: { name: 'create_task', sensitive: false, risk: 'low', targets: 'internal', description: 'Create an internal follow-up task.' },
  rag_search: { name: 'rag_search', sensitive: false, risk: 'low', targets: 'internal', description: 'Search the knowledge base (read-only).' },

  devops_create_workitem: { name: 'devops_create_workitem', sensitive: true, risk: 'medium', targets: 'devops', description: 'Create an Azure DevOps work item.' },
  devops_update_workitem: { name: 'devops_update_workitem', sensitive: true, risk: 'medium', targets: 'devops', description: 'Update an Azure DevOps work item.' },
  devops_comment: { name: 'devops_comment', sensitive: true, risk: 'low', targets: 'devops', description: 'Comment on an Azure DevOps work item.' },

  github_create_issue: { name: 'github_create_issue', sensitive: true, risk: 'medium', targets: 'github', description: 'Open a GitHub issue.' },
  github_comment: { name: 'github_comment', sensitive: true, risk: 'low', targets: 'github', description: 'Comment on a GitHub issue/PR.' },
  github_review_pr: { name: 'github_review_pr', sensitive: true, risk: 'medium', targets: 'github', description: 'Post a GitHub PR review.' },

  opsconnect_create_project: { name: 'opsconnect_create_project', sensitive: true, risk: 'medium', targets: 'opsconnect', description: 'Create an OpsConnect project.' },
  opsconnect_create_task: { name: 'opsconnect_create_task', sensitive: true, risk: 'low', targets: 'opsconnect', description: 'Create an OpsConnect task.' },
  opsconnect_update_status: { name: 'opsconnect_update_status', sensitive: true, risk: 'low', targets: 'opsconnect', description: 'Update OpsConnect status.' },
  opsconnect_comment: { name: 'opsconnect_comment', sensitive: true, risk: 'low', targets: 'opsconnect', description: 'Comment on an OpsConnect item.' },

  bc_read_customer: { name: 'bc_read_customer', sensitive: false, risk: 'low', targets: 'business_central', description: 'Read a Business Central customer (read-only).' },
  bc_read_invoices: { name: 'bc_read_invoices', sensitive: false, risk: 'low', targets: 'business_central', description: 'Read Business Central invoices (read-only).' },
  bc_read_balance: { name: 'bc_read_balance', sensitive: false, risk: 'low', targets: 'business_central', description: 'Read a customer balance (read-only).' },
  bc_create_invoice: { name: 'bc_create_invoice', sensitive: true, risk: 'high', targets: 'business_central', monetary: true, description: 'Create a BC sales invoice (always approval).' },
  bc_post_payment: { name: 'bc_post_payment', sensitive: true, risk: 'critical', targets: 'business_central', monetary: true, description: 'Post a BC payment (always approval).' },

  crm_read_record: { name: 'crm_read_record', sensitive: false, risk: 'low', targets: 'crm', description: 'Read a CRM record.' },
  crm_update_record: { name: 'crm_update_record', sensitive: true, risk: 'medium', targets: 'crm', description: 'Create/update a CRM record.' },
  create_ticket: { name: 'create_ticket', sensitive: false, risk: 'low', targets: 'opsconnect', description: 'Open a support ticket.' },
  update_ticket: { name: 'update_ticket', sensitive: false, risk: 'low', targets: 'opsconnect', description: 'Update a support ticket.' },
  create_document: { name: 'create_document', sensitive: false, risk: 'low', targets: 'internal', description: 'Save a draft document.' },
  generate_quote: { name: 'generate_quote', sensitive: true, risk: 'medium', targets: 'internal', monetary: true, description: 'Produce a priced quote.' },
  send_proposal: { name: 'send_proposal', sensitive: true, risk: 'high', targets: 'email', description: 'Deliver a proposal to a customer (always approval).' },
  handoff: { name: 'handoff', sensitive: false, risk: 'low', targets: 'internal', description: 'Route to another AI Resource.' },
  post_message: { name: 'post_message', sensitive: false, risk: 'low', targets: 'internal', description: 'Post a status/question to the mission feed (inter-agent messaging).' },
  remember: { name: 'remember', sensitive: false, risk: 'low', targets: 'internal', description: "Save a durable note to the resource's long-term memory." },
  run_report: { name: 'run_report', sensitive: false, risk: 'low', targets: 'internal', description: 'Run a named report from the safe catalog and return rows.' },
  make_chart: { name: 'make_chart', sensitive: false, risk: 'low', targets: 'internal', description: 'Describe a chart (bar/donut/line) for the UI to render.' },
  send_whatsapp_message: { name: 'send_whatsapp_message', sensitive: true, risk: 'high', targets: 'whatsapp', description: 'Send a WhatsApp message to a customer (always approval).' },
  bc_create_sales_order: { name: 'bc_create_sales_order', sensitive: true, risk: 'high', targets: 'business_central', monetary: true, description: 'Create a Business Central sales order (always approval).' },
};

// Tools that ALWAYS require human approval regardless of confidence/limit.
export const ALWAYS_APPROVE: ReadonlySet<ToolName> = new Set(
  (Object.values(TOOL_REGISTRY) as ToolDef[]).filter((t) => t.sensitive).map((t) => t.name),
);

export function isKnownTool(name: string): name is ToolName {
  return name in TOOL_REGISTRY;
}

export const ToolIntentSchema = z.object({
  tool: z.string(),
  sensitive: z.boolean().optional(),
  args: z.record(z.unknown()).default({}),
  rationale: z.string().optional(),
  idempotency_key: z.string().optional(),
  // optional explicit connection target (integrations.id) for multi-connection routing
  target_integration_id: z.string().uuid().optional(),
});
export type ToolIntent = z.infer<typeof ToolIntentSchema>;
