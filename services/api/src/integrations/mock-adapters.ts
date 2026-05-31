import { Logger } from '@nestjs/common';
import type { IntegrationKind, ToolName } from '@dynops/shared';
import type { ConnectorAdapter, ConnectionInfo, ExecResult } from './contracts';

// A generic mock connector: simulates the external side effect, logs it, and
// returns a synthetic external id. One instance per IntegrationKind. Real
// adapters (GraphEmailAdapter, AzureDevOpsAdapter, BusinessCentralAdapter, …)
// swap in behind this same interface in M6.
class MockAdapter implements ConnectorAdapter {
  private readonly logger: Logger;
  constructor(public readonly kind: IntegrationKind) {
    this.logger = new Logger(`Mock:${kind}`);
  }

  async healthCheck(conn: ConnectionInfo) {
    return { ok: true, latencyMs: 3, detail: `mock ${this.kind} (${conn.name})` };
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    const externalId = `${this.kind}-${Math.round(performance.now())}-${tool}`;
    this.logger.log(`EXECUTE ${tool} via "${conn.name}" args=${JSON.stringify(args).slice(0, 300)}`);
    // Per-kind synthetic responses (enough to make the UI + audit meaningful).
    switch (this.kind) {
      case 'email':
        return { ok: true, external_id: externalId, detail: `Email "sent" to ${(args.to as string[])?.join(', ') ?? args.recipients}` , data: { simulated: true } };
      case 'business_central':
        return { ok: true, external_id: externalId, detail: `BC ${tool} on company "${conn.config.company}"`, data: { company: conn.config.company, simulated: true } };
      case 'devops':
        return { ok: true, external_id: externalId, detail: `ADO ${tool} in org "${conn.config.org}"`, data: { org: conn.config.org } };
      case 'github':
        return { ok: true, external_id: externalId, detail: `GitHub ${tool} on "${conn.config.repo}"`, data: { repo: conn.config.repo } };
      case 'opsconnect':
        return { ok: true, external_id: externalId, detail: `OpsConnect ${tool}`, data: { base_url: conn.config.base_url } };
      default:
        return { ok: true, external_id: externalId, detail: `${this.kind} ${tool} simulated` };
    }
  }
}

const ADAPTERS: Record<IntegrationKind, ConnectorAdapter> = {
  email: new MockAdapter('email'),
  teams: new MockAdapter('teams'),
  calendar: new MockAdapter('calendar'),
  devops: new MockAdapter('devops'),
  github: new MockAdapter('github'),
  opsconnect: new MockAdapter('opsconnect'),
  business_central: new MockAdapter('business_central'),
  crm: new MockAdapter('crm'),
  internal: new MockAdapter('internal'),
};

export function getAdapter(kind: IntegrationKind): ConnectorAdapter {
  return ADAPTERS[kind];
}
