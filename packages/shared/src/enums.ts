// Shared string-literal enums mirroring the Prisma schema. Kept in one place so
// api, worker, and the web client agree on the wire vocabulary.

export const ACTIVITY_CHANNELS = [
  'email',
  'teams',
  'calendar',
  'devops',
  'github',
  'opsconnect',
  'business_central',
  'crm',
  'erp',
  'sharepoint',
  'ticket',
  'document',
  'manual',
  'mission',
  'whatsapp',
  'chat',
] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];

export const ACTIVITY_STATUSES = [
  'new',
  'triaging',
  'routed',
  'in_progress',
  'awaiting_approval',
  'completed',
  'escalated',
  'failed',
  'archived',
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'needs_approval', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TOOL_CALL_STATUSES = [
  'proposed',
  'awaiting_approval',
  'approved',
  'executing',
  'succeeded',
  'failed',
  'skipped',
  'rejected',
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const USER_ROLES = ['admin', 'manager', 'consultant', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai', 'azure_openai', 'gemini'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const INTEGRATION_TYPES = [
  'ado_org',
  'github',
  'opsconnect',
  'business_central',
  'graph_email',
  'graph_calendar',
  'graph_teams',
  'sharepoint',
  'crm',
  'whatsapp',
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_DIRECTIONS = ['in', 'out', 'both'] as const;
export type IntegrationDirection = (typeof INTEGRATION_DIRECTIONS)[number];

// Role rank for simple RBAC comparisons (higher = more privilege).
export const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  consultant: 1,
  manager: 2,
  admin: 3,
};
