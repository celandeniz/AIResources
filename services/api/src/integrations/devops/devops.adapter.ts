// Minimal Azure DevOps reader for backtesting: work items assigned to a user,
// across one or more orgs, via the REST API + a PAT. Read-only.
// Activates only when ADO_PAT + ADO_ORGS env are set (else returns []).

import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';
import type { IntegrationKind, ToolName } from '@dynops/shared';

export interface DevOpsItem {
  id: string;
  org: string;
  title: string;
  type: string;
  state: string;
  description: string;
  assignee?: string;
  changedDate?: string;
  priority?: number;
  project?: string;
}

export function devopsConfigured(): boolean {
  return Boolean(process.env.ADO_PAT && process.env.ADO_ORGS);
}

async function adoFetch(url: string, pat: string): Promise<any> {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const res = await fetch(url, { headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' } });
  if (!res.ok) throw new Error(`ADO ${res.status} ${url}`);
  return res.json();
}

// JSON-Patch POST/PATCH helper — uses application/json-patch+json content-type.
async function adoPatch(url: string, pat: string, body: unknown[], method: 'POST' | 'PATCH' = 'PATCH'): Promise<any> {
  const auth = Buffer.from(`:${pat}`).toString('base64');
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json-patch+json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ADO ${res.status} ${url} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function fetchAssignedWorkItems(assignee: string, cap = 50): Promise<DevOpsItem[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  const orgs = (process.env.ADO_ORGS as string).split(',').map((s) => s.trim()).filter(Boolean);
  const out: DevOpsItem[] = [];
  for (const org of orgs) {
    if (out.length >= cap) break;
    try {
      const wiql: any = await fetch(`https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.0`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = '${assignee}' AND [System.State] <> 'Closed' ORDER BY [System.ChangedDate] DESC` }),
      }).then((r) => r.json());
      const ids = (wiql.workItems ?? []).slice(0, cap - out.length).map((w: any) => w.id);
      if (!ids.length) continue;
      const items = await adoFetch(`https://dev.azure.com/${org}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Title,System.Description,System.WorkItemType,System.State&api-version=7.0`, pat);
      for (const w of items.value ?? []) {
        out.push({
          id: `ado-${org}-${w.id}`,
          org,
          title: w.fields?.['System.Title'] ?? `Work item ${w.id}`,
          type: w.fields?.['System.WorkItemType'] ?? 'Task',
          state: w.fields?.['System.State'] ?? '',
          description: (w.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, '').slice(0, 1000),
        });
      }
    } catch {
      /* skip org on error */
    }
  }
  return out;
}

// Fetch work items changed since sinceISO across a single org, capped at cap.
export async function fetchRecentWorkItems(org: string, sinceISO: string, cap = 25): Promise<DevOpsItem[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  try {
    const wiql: any = await fetch(`https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.0`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '${sinceISO.split('T')[0]}' ORDER BY [System.ChangedDate] DESC`,
      }),
    }).then((r) => r.json());
    const ids = (wiql.workItems ?? []).slice(0, cap).map((w: any) => w.id);
    if (!ids.length) return [];
    const items = await adoFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Title,System.Description,System.WorkItemType,System.State,System.AssignedTo,System.ChangedDate,Microsoft.VSTS.Common.Priority&api-version=7.0`,
      pat,
    );
    return (items.value ?? []).map((w: any) => ({
      id: String(w.id),
      org,
      title: w.fields?.['System.Title'] ?? `Work item ${w.id}`,
      type: w.fields?.['System.WorkItemType'] ?? 'Task',
      state: w.fields?.['System.State'] ?? '',
      description: (w.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, '').slice(0, 1000),
      assignee: w.fields?.['System.AssignedTo']?.displayName ?? w.fields?.['System.AssignedTo'] ?? undefined,
      changedDate: w.fields?.['System.ChangedDate'] ?? undefined,
      priority: w.fields?.['Microsoft.VSTS.Common.Priority'] != null ? Number(w.fields['Microsoft.VSTS.Common.Priority']) : undefined,
      project: (w._links?.html?.href as string | undefined)?.split('/')?.find((_, i, a) => a[i - 1] === org) ?? undefined,
    }));
  } catch {
    return [];
  }
}

// Fetch comments for a single work item (plain text, stripped of HTML).
export async function fetchWorkItemComments(org: string, id: string, cap = 10): Promise<{ text: string; by?: string; at?: string }[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  try {
    const data = await adoFetch(
      `https://dev.azure.com/${org}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`,
      pat,
    );
    return (data.comments ?? []).slice(0, cap).map((c: any) => ({
      text: (c.text ?? '').replace(/<[^>]+>/g, '').trim(),
      by: c.createdBy?.displayName ?? undefined,
      at: c.createdDate ?? undefined,
    }));
  } catch {
    return [];
  }
}

// ── DevOpsAdapter — live write adapter implementing ConnectorAdapter ───────────
export class DevOpsAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'devops';

  async healthCheck(conn: ConnectionInfo): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    if (!devopsConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'ADO_PAT not set' };
    }
    const org = conn.config.org as string;
    const pat = process.env.ADO_PAT!;
    const start = Date.now();
    try {
      await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.0`, pat);
      return { ok: true, latencyMs: Date.now() - start, detail: `ADO OK — org ${org}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
    }
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    const org = conn.config.org as string;
    const project = (args.project as string) ?? (conn.config.project as string);
    const pat = process.env.ADO_PAT;
    if (!pat) return { ok: false, detail: 'ADO_PAT not configured' };

    if (tool === 'devops_comment') {
      const wid = args.workItemId ?? args.ado_id ?? args.id;
      const text = String(args.text ?? args.body ?? args.content ?? '');
      if (!wid || !text) return { ok: false, detail: 'devops_comment requires workItemId and text' };
      try {
        const auth = Buffer.from(`:${pat}`).toString('base64');
        const res = await fetch(
          `https://dev.azure.com/${org}/_apis/wit/workItems/${wid}/comments?api-version=7.1-preview.3`,
          {
            method: 'POST',
            headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          },
        );
        if (!res.ok) throw new Error(`ADO ${res.status}`);
        return { ok: true, external_id: String(wid), detail: `Commented on ADO #${wid} in ${org}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    if (tool === 'devops_create_workitem') {
      const type = String(args.type ?? 'Task');
      const title = String(args.title ?? '');
      const description = String(args.description ?? '');
      if (!title) return { ok: false, detail: 'devops_create_workitem requires title' };
      if (!project) return { ok: false, detail: 'devops_create_workitem requires project (args.project or conn.config.project)' };
      try {
        const resp = await adoPatch(
          `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1`,
          pat,
          [
            { op: 'add', path: '/fields/System.Title', value: title },
            { op: 'add', path: '/fields/System.Description', value: description },
          ],
          'POST',
        );
        return { ok: true, external_id: String(resp.id), detail: `Created ADO #${resp.id} in ${org}/${project}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    if (tool === 'devops_update_workitem') {
      const wid = args.workItemId ?? args.ado_id ?? args.id;
      if (!wid) return { ok: false, detail: 'devops_update_workitem requires workItemId' };
      const ops: { op: string; path: string; value: unknown }[] = [];
      if (args.state) ops.push({ op: 'add', path: '/fields/System.State', value: args.state });
      if (args.assignee) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: args.assignee });
      if (args.title) ops.push({ op: 'add', path: '/fields/System.Title', value: args.title });
      if (args.description) ops.push({ op: 'add', path: '/fields/System.Description', value: args.description });
      if (!ops.length) return { ok: false, detail: 'devops_update_workitem: no updatable fields provided' };
      try {
        await adoPatch(
          `https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=7.1`,
          pat,
          ops,
          'PATCH',
        );
        return { ok: true, external_id: String(wid), detail: `Updated ADO #${wid}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    return { ok: false, detail: `DevOpsAdapter cannot execute ${tool}` };
  }
}

export const devOpsAdapter = new DevOpsAdapter();
