import type { IntegrationKind, ToolName } from '@dynops/shared';

export interface ExecResult {
  ok: boolean;
  external_id?: string;
  detail?: string;
  data?: Record<string, unknown>;
}

export interface ConnectionInfo {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isMock: boolean;
}

// Every integration adapter implements this. Mock* now → Graph*/DevOps*/BC* in M6.
export interface ConnectorAdapter {
  readonly kind: IntegrationKind;
  healthCheck(conn: ConnectionInfo): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
  execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult>;
}
