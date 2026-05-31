import { z } from 'zod';
import { ToolIntentSchema } from './tool-intents';

// ─────────────────────────────────────────────────────────────────────────────
// The hybrid Node↔Python seam. These schemas are the canonical contract for
// POST {AGENT_URL}/v1/agents/run. The Python service validates its LLM output
// against AgentResult before returning; the worker validates the response.
// ─────────────────────────────────────────────────────────────────────────────

export const AgentDraftSchema = z.object({
  kind: z.enum(['email_reply', 'proposal', 'ticket', 'task_plan', 'note', 'chat_reply', 'none']),
  subject: z.string().nullable().optional(),
  content: z.string(),
  recipients: z.array(z.string()).default([]),
  citations: z.array(z.string()).default([]),
});
export type AgentDraft = z.infer<typeof AgentDraftSchema>;

export const AgentResultSchema = z.object({
  draft: AgentDraftSchema,
  reasoning_summary: z.string(),
  confidence: z.number().min(0).max(1),
  needs_escalation: z.boolean(),
  escalate_to: z.string().nullable().optional(),
  tool_intents: z.array(ToolIntentSchema).default([]),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

// Full agent response (AgentResult + run metadata).
export const AgentRunResponseSchema = AgentResultSchema.extend({
  run_id: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  token_usage: z
    .object({ input: z.number().optional(), output: z.number().optional(), cache_read: z.number().optional() })
    .optional(),
  latency_ms: z.number().optional(),
});
export type AgentRunResponse = z.infer<typeof AgentRunResponseSchema>;

// Request the worker sends to the agent.
export const AgentRunRequestSchema = z.object({
  run_id: z.string(),
  workspace_id: z.string().nullable().optional(),
  ai_resource: z.object({
    key: z.string(),
    name: z.string(),
    system_prompt: z.string(),
    provider: z.string(),
    model: z.string(),
    temperature: z.number().optional(),
    tools: z.array(z.string()),
    confidence_threshold: z.number(),
  }),
  activity: z.object({
    id: z.string(),
    channel: z.string(),
    subject: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    priority: z.string().optional(),
    customer: z.object({ id: z.string(), name: z.string(), tier: z.string().nullable().optional() }).nullable().optional(),
    project: z.object({ id: z.string(), name: z.string(), status: z.string().nullable().optional() }).nullable().optional(),
    received_at: z.string().optional(),
  }),
  context: z
    .object({
      thread: z
        .array(z.object({ role: z.string(), from: z.string().optional(), at: z.string().optional(), text: z.string() }))
        .default([]),
      rag_hints: z.array(z.string()).default([]),
      user_timezone: z.string().optional(),
      rag_hits: z.array(z.any()).optional(),
    })
    .default({ thread: [], rag_hints: [] }),
  options: z.object({ prompt_caching: z.boolean().optional(), max_tool_intents: z.number().optional() }).optional(),
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

// RAG ingest / search contracts.
export const RagIngestRequestSchema = z.object({
  document_id: z.string(),
  title: z.string(),
  text: z.string(),
  metadata: z.object({ workspace_id: z.string().nullable().optional(), customer_id: z.string().nullable().optional(), project_id: z.string().nullable().optional(), tags: z.array(z.string()).default([]) }).default({ tags: [] }),
});
export type RagIngestRequest = z.infer<typeof RagIngestRequestSchema>;

export const RagSearchRequestSchema = z.object({
  query: z.string(),
  top_k: z.number().default(5),
  filter: z.object({ workspace_id: z.string().nullable().optional(), customer_id: z.string().nullable().optional(), project_id: z.string().nullable().optional() }).optional(),
});
export type RagSearchRequest = z.infer<typeof RagSearchRequestSchema>;
