import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  workspaceId?: string;
  userId?: string;
  role?: string;
}

export const tenantStore = new AsyncLocalStorage<TenantStore>();

export function currentWorkspaceId(): string | undefined {
  return tenantStore.getStore()?.workspaceId;
}

// Tenant-scoped Prisma models. workspace_id is injected on reads/writes when a
// workspace context is active. (users/permissions/workspaces/memberships are
// cross-workspace/system and intentionally NOT scoped.)
export const TENANT_MODELS = new Set([
  'ai_resources', 'activity_sources', 'activities', 'customers', 'projects',
  'workflows', 'workflow_rules', 'agent_runs', 'tool_calls', 'approvals',
  'tasks', 'messages', 'documents', 'knowledge_chunks', 'integrations', 'audit_logs',
  'agent_feedback', 'backtests', 'backtest_items', 'prompt_versions', 'notifications',
  'templates', 'digest_results', 'automations', 'missions', 'agent_messages',
  'resource_memories', 'skills', 'reports', 'status_reports', 'style_profiles', 'style_examples',
  'code_tasks',
]);
