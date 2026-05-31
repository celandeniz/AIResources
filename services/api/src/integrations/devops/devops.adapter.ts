// Minimal Azure DevOps reader for backtesting: work items assigned to a user,
// across one or more orgs, via the REST API + a PAT. Read-only.
// Activates only when ADO_PAT + ADO_ORGS env are set (else returns []).

export interface DevOpsItem {
  id: string;
  org: string;
  title: string;
  type: string;
  state: string;
  description: string;
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
