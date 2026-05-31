import type { AgentRunRequest, AgentRunResponse } from '@dynops/shared';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

export async function runAgent(req: AgentRunRequest): Promise<AgentRunResponse> {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`agent /v1/agents/run ${res.status}: ${text}`);
  }
  return (await res.json()) as AgentRunResponse;
}

// Ask the API (which owns adapters) to execute an auto-approved tool call.
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export async function executeToolCallViaApi(toolCallId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/tool-calls/${toolCallId}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`api execute tool-call ${res.status}: ${text}`);
  }
}
