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
  changedBy?: string;
  rev?: number;
  tags?: string[];
  iterationPath?: string;
  areaPath?: string;
  targetDate?: string;
  dueDate?: string;
  relations?: { rel: string; url: string }[];
}

export function devopsConfigured(): boolean {
  return Boolean(process.env.ADO_PAT && process.env.ADO_ORGS);
}

// Invisible marker appended to every platform-authored ADO comment so the
// ingestion loop (and comment seeding) can recognise & skip our own output.
export const ADO_SELF_MARKER = '<!-- dynops:v1 -->';

// Resolve the identity the PAT authenticates as (used for echo suppression:
// work-item changes made by the platform itself must not be re-ingested).
// Falls back to ADO_SELF_IDENTITY env ("Display Name <email>"); resolving
// NOTHING means callers must fail closed (no update re-ingestion).
let selfIdentityCache: { displayName?: string; email?: string } | null | undefined;
export async function adoSelfIdentity(org: string): Promise<{ displayName?: string; email?: string } | null> {
  if (selfIdentityCache !== undefined) return selfIdentityCache;
  const envId = process.env.ADO_SELF_IDENTITY;
  if (envId) {
    const m = envId.match(/^(.*?)\s*<([^>]+)>\s*$/);
    selfIdentityCache = m ? { displayName: m[1].trim(), email: m[2].trim() } : { displayName: envId.trim() };
    return selfIdentityCache;
  }
  if (!devopsConfigured()) { selfIdentityCache = null; return null; }
  try {
    const data = await adoFetch(`https://dev.azure.com/${org}/_apis/connectionData?api-version=7.1-preview.1`, process.env.ADO_PAT!);
    const u = data?.authenticatedUser;
    selfIdentityCache = u
      ? { displayName: u.providerDisplayName ?? u.customDisplayName ?? undefined, email: (u.properties?.Account?.$value as string | undefined) ?? undefined }
      : null;
  } catch {
    selfIdentityCache = null;
  }
  return selfIdentityCache;
}

export function isSelfAuthored(by: string | undefined, self: { displayName?: string; email?: string } | null): boolean {
  if (!by || !self) return false;
  const b = by.toLowerCase();
  return Boolean(
    (self.displayName && b.includes(self.displayName.toLowerCase())) ||
    (self.email && b.includes(self.email.toLowerCase())),
  );
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
    // $expand=relations cannot be combined with fields= — fetch all fields.
    const items = await adoFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=relations&api-version=7.0`,
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
      project: w.fields?.['System.TeamProject'] ?? undefined,
      changedBy: w.fields?.['System.ChangedBy']?.displayName ?? w.fields?.['System.ChangedBy']?.uniqueName ?? undefined,
      rev: w.rev != null ? Number(w.rev) : undefined,
      tags: typeof w.fields?.['System.Tags'] === 'string'
        ? (w.fields['System.Tags'] as string).split(';').map((t: string) => t.trim()).filter(Boolean)
        : undefined,
      iterationPath: w.fields?.['System.IterationPath'] ?? undefined,
      areaPath: w.fields?.['System.AreaPath'] ?? undefined,
      targetDate: w.fields?.['Microsoft.VSTS.Scheduling.TargetDate'] ?? undefined,
      dueDate: w.fields?.['Microsoft.VSTS.Scheduling.DueDate'] ?? undefined,
      relations: Array.isArray(w.relations)
        ? w.relations.map((r: any) => ({ rel: String(r.rel ?? ''), url: String(r.url ?? '') }))
        : undefined,
    }));
  } catch {
    return [];
  }
}

// List the projects of one org (needs Project & Team Read scope).
export async function fetchAdoProjects(org: string): Promise<{ id: string; name: string }[]> {
  if (!devopsConfigured()) return [];
  try {
    const data = await adoFetch(`https://dev.azure.com/${org}/_apis/projects?api-version=7.0&$top=100`, process.env.ADO_PAT!);
    return (data.value ?? []).map((p: any) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}

// ALL open work items of one project (regardless of last-change date) — the
// project dashboard's "açık işler" source. WIQL project-scoped, terminal
// states excluded, then the same $expand=relations batch mapping.
export async function fetchOpenWorkItems(org: string, project: string, cap = 200): Promise<DevOpsItem[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  try {
    const proj = project.replace(/'/g, "''");
    const wiql: any = await fetch(`https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.0`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${proj}' AND [System.State] NOT IN ('Closed','Done','Removed','Resolved') ORDER BY [System.ChangedDate] DESC`,
      }),
    }).then((r) => r.json());
    const ids = (wiql.workItems ?? []).slice(0, cap).map((w: any) => w.id);
    const out: DevOpsItem[] = [];
    // Batch endpoint caps at 200 ids per call.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const items = await adoFetch(
        `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${chunk.join(',')}&$expand=relations&api-version=7.0`,
        pat,
      );
      for (const w of items.value ?? []) out.push(mapWorkItem(w, org));
    }
    return out;
  } catch {
    return [];
  }
}

// User stories / PBIs / requirements of a project (for description-quality
// audits and customer-doc generation).
export async function fetchUserStories(org: string, project: string, cap = 100): Promise<DevOpsItem[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  try {
    const proj = project.replace(/'/g, "''");
    const wiql: any = await fetch(`https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.0`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${proj}' AND [System.WorkItemType] IN ('User Story','Product Backlog Item','Requirement') ORDER BY [System.ChangedDate] DESC`,
      }),
    }).then((r) => r.json());
    const ids = (wiql.workItems ?? []).slice(0, cap).map((w: any) => w.id);
    const out: DevOpsItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const items = await adoFetch(
        `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${chunk.join(',')}&$expand=relations&api-version=7.0`,
        pat,
      );
      for (const w of items.value ?? []) out.push(mapWorkItem(w, org));
    }
    return out;
  } catch {
    return [];
  }
}

// Child work items (tasks under a user story) via hierarchy-forward relations —
// doc generation mines them for implementation detail the story itself lacks.
export async function fetchChildItems(org: string, parent: DevOpsItem): Promise<(DevOpsItem & { descriptionFull: string })[]> {
  if (!devopsConfigured()) return [];
  const childIds = (parent.relations ?? [])
    .filter((r) => /Hierarchy-Forward/i.test(r.rel))
    .map((r) => r.url.match(/workItems\/(\d+)/i)?.[1])
    .filter((x): x is string => Boolean(x))
    .slice(0, 20);
  if (!childIds.length) return [];
  try {
    const items = await adoFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${childIds.join(',')}&api-version=7.0`,
      process.env.ADO_PAT!,
    );
    return (items.value ?? []).map((w: any) => ({
      ...mapWorkItem(w, org),
      descriptionFull: String(w.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200),
    }));
  } catch {
    return [];
  }
}

// Ancestor chain via hierarchy-REVERSE links: User Story → Feature → Epic.
// Story enrichment reads the business goal from up here — a story's own text
// rarely states why the work exists, but its Feature/Epic almost always does.
// Returns nearest-parent-first; stops at the top or maxDepth (cycle-safe).
export async function fetchAncestors(
  org: string,
  item: DevOpsItem,
  maxDepth = 3,
): Promise<(DevOpsItem & { descriptionFull: string })[]> {
  if (!devopsConfigured()) return [];
  const out: (DevOpsItem & { descriptionFull: string })[] = [];
  const seen = new Set<string>([String(item.id)]);
  let current: DevOpsItem = item;
  try {
    for (let depth = 0; depth < maxDepth; depth++) {
      const parentId = (current.relations ?? [])
        .filter((r) => /Hierarchy-Reverse/i.test(r.rel))
        .map((r) => r.url.match(/workItems\/(\d+)/i)?.[1])
        .find((x): x is string => Boolean(x));
      if (!parentId || seen.has(parentId)) break;
      seen.add(parentId);
      const w = await adoFetch(
        `https://dev.azure.com/${org}/_apis/wit/workitems/${parentId}?$expand=relations&api-version=7.0`,
        process.env.ADO_PAT!,
      );
      const parent = {
        ...mapWorkItem(w, org),
        descriptionFull: String(w.fields?.['System.Description'] ?? '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000),
      };
      out.push(parent);
      current = parent;
    }
  } catch {
    // Partial chain is still useful — return whatever resolved.
  }
  return out;
}

// One work item with the FULL (untruncated) description — doc generation needs
// the whole text, not the 1000-char ingest slice.
export async function fetchWorkItemFull(org: string, id: string): Promise<(DevOpsItem & { descriptionFull: string; acceptance?: string }) | null> {
  if (!devopsConfigured()) return null;
  try {
    const w = await adoFetch(`https://dev.azure.com/${org}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`, process.env.ADO_PAT!);
    const item = mapWorkItem(w, org);
    return {
      ...item,
      descriptionFull: String(w.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000),
      acceptance: String(w.fields?.['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000) || undefined,
    };
  } catch {
    return null;
  }
}

function mapWorkItem(w: any, org: string): DevOpsItem {
  return {
    id: String(w.id),
    org,
    title: w.fields?.['System.Title'] ?? `Work item ${w.id}`,
    type: w.fields?.['System.WorkItemType'] ?? 'Task',
    state: w.fields?.['System.State'] ?? '',
    description: (w.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, '').slice(0, 1000),
    assignee: w.fields?.['System.AssignedTo']?.displayName ?? w.fields?.['System.AssignedTo'] ?? undefined,
    changedDate: w.fields?.['System.ChangedDate'] ?? undefined,
    priority: w.fields?.['Microsoft.VSTS.Common.Priority'] != null ? Number(w.fields['Microsoft.VSTS.Common.Priority']) : undefined,
    project: w.fields?.['System.TeamProject'] ?? undefined,
    changedBy: w.fields?.['System.ChangedBy']?.displayName ?? w.fields?.['System.ChangedBy']?.uniqueName ?? undefined,
    rev: w.rev != null ? Number(w.rev) : undefined,
    tags: typeof w.fields?.['System.Tags'] === 'string'
      ? (w.fields['System.Tags'] as string).split(';').map((t: string) => t.trim()).filter(Boolean)
      : undefined,
    iterationPath: w.fields?.['System.IterationPath'] ?? undefined,
    areaPath: w.fields?.['System.AreaPath'] ?? undefined,
    targetDate: w.fields?.['Microsoft.VSTS.Scheduling.TargetDate'] ?? undefined,
    dueDate: w.fields?.['Microsoft.VSTS.Scheduling.DueDate'] ?? undefined,
    relations: Array.isArray(w.relations)
      ? w.relations.map((r: any) => ({ rel: String(r.rel ?? ''), url: String(r.url ?? '') }))
      : undefined,
  };
}

// Fetch comments for a single work item (plain text, stripped of HTML).
// filterSelf drops platform-authored comments (marker or self identity) so
// mission seed context never contains our own output.
export async function fetchWorkItemComments(
  org: string,
  id: string,
  cap = 10,
  opts?: { filterSelf?: boolean },
): Promise<{ text: string; by?: string; at?: string }[]> {
  if (!devopsConfigured()) return [];
  const pat = process.env.ADO_PAT!;
  try {
    // Comments API needs the project segment — resolve via the work item.
    const wi = await adoFetch(`https://dev.azure.com/${org}/_apis/wit/workitems/${id}?api-version=7.0`, pat);
    const proj = wi?.fields?.['System.TeamProject'];
    if (!proj) return [];
    const data = await adoFetch(
      `https://dev.azure.com/${org}/${encodeURIComponent(proj)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`,
      pat,
    );
    let comments: any[] = data.comments ?? [];
    if (opts?.filterSelf) {
      const self = await adoSelfIdentity(org);
      comments = comments.filter(
        (c: any) => !String(c.text ?? '').includes(ADO_SELF_MARKER) && !isSelfAuthored(c.createdBy?.displayName, self),
      );
    }
    return comments.slice(0, cap).map((c: any) => ({
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
        // The comments API (unlike work-item PATCH) REQUIRES the project
        // segment. Resolve it from the work item itself when not provided.
        let proj = project;
        if (!proj) {
          const wi = await adoFetch(`https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=7.0`, pat);
          proj = wi?.fields?.['System.TeamProject'];
        }
        if (!proj) return { ok: false, detail: `devops_comment: could not resolve project for #${wid}` };
        const auth = Buffer.from(`:${pat}`).toString('base64');
        const res = await fetch(
          `https://dev.azure.com/${org}/${encodeURIComponent(proj)}/_apis/wit/workItems/${wid}/comments?api-version=7.1-preview.3`,
          {
            method: 'POST',
            headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
            // Marker lets ingestion recognise & skip our own comments (echo guard).
            body: JSON.stringify({ text: `${text}\n${ADO_SELF_MARKER}` }),
          },
        );
        if (!res.ok) throw new Error(`ADO ${res.status}`);
        return { ok: true, external_id: String(wid), detail: `Commented on ADO #${wid} in ${org}/${proj}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    if (tool === 'devops_set_state') {
      const wid = args.workItemId ?? args.ado_id ?? args.id;
      const state = String(args.state ?? '');
      if (!wid || !state) return { ok: false, detail: 'devops_set_state requires workItemId and state' };
      // Non-sensitive by design → the adapter itself enforces the whitelist.
      // Terminal states (Closed/Done) are never auto-set; merge/delivery stay human.
      const allowed = (process.env.ADO_AUTO_STATES ?? 'Active,In Progress,Resolved,Ready for Review')
        .split(',').map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes(state)) {
        return { ok: false, detail: `state '${state}' not in auto whitelist (${allowed.join(', ')})` };
      }
      try {
        await adoPatch(
          `https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=7.1`,
          pat,
          [{ op: 'add', path: '/fields/System.State', value: state }],
          'PATCH',
        );
        return { ok: true, external_id: String(wid), detail: `ADO #${wid} → ${state}` };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    }

    if (tool === 'devops_link_workitem') {
      const wid = args.workItemId ?? args.ado_id ?? args.id;
      if (!wid) return { ok: false, detail: 'devops_link_workitem requires workItemId' };
      const url = args.url
        ? String(args.url)
        : args.targetId
          ? `https://dev.azure.com/${org}/_apis/wit/workItems/${args.targetId}`
          : null;
      if (!url) return { ok: false, detail: 'devops_link_workitem requires url or targetId' };
      const rel = String(args.rel ?? (args.url ? 'Hyperlink' : 'System.LinkTypes.Related'));
      try {
        await adoPatch(
          `https://dev.azure.com/${org}/_apis/wit/workitems/${wid}?api-version=7.1`,
          pat,
          [{ op: 'add', path: '/relations/-', value: { rel, url, attributes: { comment: String(args.comment ?? 'Linked by DynOps') } } }],
          'PATCH',
        );
        return { ok: true, external_id: String(wid), detail: `Linked ${rel} on ADO #${wid}` };
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
      if (args.acceptance) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: args.acceptance });
      if (Array.isArray(args.tags)) ops.push({ op: 'add', path: '/fields/System.Tags', value: (args.tags as string[]).join('; ') });
      if (args.iteration) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: args.iteration });
      if (args.area) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: args.area });
      if (args.storyPoints != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: Number(args.storyPoints) });
      if (args.remainingWork != null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: Number(args.remainingWork) });
      if (args.targetDate) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: args.targetDate });
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
