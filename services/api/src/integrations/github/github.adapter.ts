// GitHub live write adapter implementing ConnectorAdapter.
// Activates only when GITHUB_TOKEN env is set (else executor falls back to mock).
// Never throws out of execute()/healthCheck — always returns { ok:false, detail }.

import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';
import type { IntegrationKind, ToolName } from '@dynops/shared';

export function githubConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

// Thin GitHub REST helper. Throws on !res.ok; returns parsed JSON (or null on empty body).
async function ghFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dynops-ai-platform',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} ${path} — ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export class GitHubAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'github';

  async healthCheck(conn: ConnectionInfo): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    if (!githubConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'GITHUB_TOKEN not set' };
    }
    const repo = String(conn.config.repo ?? '');
    const start = Date.now();
    try {
      await ghFetch(`/repos/${repo}`);
      return { ok: true, latencyMs: Date.now() - start, detail: `GitHub OK — ${repo}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
    }
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    const repo = String(conn.config.repo ?? '');
    if (!repo) return { ok: false, detail: 'github connection missing config.repo (owner/repo)' };
    if (!githubConfigured()) return { ok: false, detail: 'GITHUB_TOKEN not configured' };

    try {
      if (tool === 'github_create_issue') {
        const title = String(args.title ?? args.subject ?? '');
        const body = String(args.body ?? args.description ?? args.content ?? '');
        if (!title) return { ok: false, detail: 'github_create_issue requires title' };
        const resp = await ghFetch(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body }) });
        return {
          ok: true,
          external_id: String(resp.number),
          detail: `Opened ${repo}#${resp.number}`,
          data: { html_url: resp.html_url },
        };
      }

      if (tool === 'github_comment') {
        const num = args.number ?? args.issue ?? args.pr ?? args.id;
        const body = String(args.body ?? args.text ?? args.content ?? '');
        if (!num || !body) return { ok: false, detail: 'github_comment requires number and body' };
        const resp = await ghFetch(`/repos/${repo}/issues/${num}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
        return {
          ok: true,
          external_id: String(resp.id),
          detail: `Commented on ${repo}#${num}`,
          data: { html_url: resp.html_url },
        };
      }

      if (tool === 'github_review_pr') {
        const num = args.number ?? args.pr ?? args.id;
        const body = String(args.body ?? args.comment ?? '');
        const event = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(String(args.event)) ? String(args.event) : 'COMMENT';
        if (!num) return { ok: false, detail: 'github_review_pr requires PR number' };
        const resp = await ghFetch(`/repos/${repo}/pulls/${num}/reviews`, { method: 'POST', body: JSON.stringify({ body, event }) });
        return {
          ok: true,
          external_id: String(resp.id),
          detail: `Reviewed PR ${repo}#${num} (${event})`,
          data: { html_url: resp.html_url },
        };
      }

      if (tool === 'github_create_pr') {
        const head = String(args.head ?? args.branch ?? '');
        const base = String(args.base ?? 'main');
        const title = String(args.title ?? '');
        if (!head || !title) return { ok: false, detail: 'github_create_pr requires head (branch) and title' };
        const resp = await ghFetch(`/repos/${args.repo ?? repo}/pulls`, {
          method: 'POST',
          // Draft by default — merge stays a human decision.
          body: JSON.stringify({ title, head, base, body: String(args.body ?? ''), draft: args.draft !== false }),
        });
        return {
          ok: true,
          external_id: String(resp.number),
          detail: `Opened PR ${args.repo ?? repo}#${resp.number} (${head} → ${base})`,
          data: { html_url: resp.html_url, number: resp.number },
        };
      }

      if (tool === 'github_dispatch_workflow') {
        const workflow = String(args.workflow ?? '');
        const ref = String(args.ref ?? args.branch ?? 'main');
        if (!workflow) return { ok: false, detail: 'github_dispatch_workflow requires workflow (file name or id)' };
        await ghFetch(`/repos/${args.repo ?? repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
          method: 'POST',
          body: JSON.stringify({ ref, inputs: (args.inputs as Record<string, unknown>) ?? {} }),
        });
        return { ok: true, detail: `Dispatched ${workflow}@${ref} on ${args.repo ?? repo}` };
      }

      return { ok: false, detail: `GitHubAdapter cannot execute ${tool}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

export const gitHubAdapter = new GitHubAdapter();

// ── Read helpers for repo profiling (WS6 tech-stack-aware docs) ──────────────
// Best-effort by design: callers treat null/[] as "no repo insight available".

export async function getRepoTree(repo: string, branch?: string, cap = 3000): Promise<{ path: string; size?: number }[]> {
  if (!githubConfigured()) return [];
  try {
    const ref = branch ?? (await ghFetch(`/repos/${repo}`))?.default_branch ?? 'main';
    const resp = await ghFetch(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return ((resp?.tree ?? []) as any[])
      .filter((e) => e.type === 'blob')
      .slice(0, cap)
      .map((e) => ({ path: String(e.path), size: typeof e.size === 'number' ? e.size : undefined }));
  } catch {
    return [];
  }
}

export async function getFileContent(repo: string, filePath: string, maxBytes = 60_000): Promise<string | null> {
  if (!githubConfigured()) return null;
  try {
    const resp = await ghFetch(`/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`);
    if (!resp?.content) return null;
    const buf = Buffer.from(String(resp.content), 'base64');
    return buf.subarray(0, maxBytes).toString('utf8');
  } catch {
    return null;
  }
}

export async function getReadme(repo: string, maxChars = 1200): Promise<string | null> {
  if (!githubConfigured()) return null;
  try {
    const resp = await ghFetch(`/repos/${repo}/readme`);
    if (!resp?.content) return null;
    return Buffer.from(String(resp.content), 'base64').toString('utf8').slice(0, maxChars);
  } catch {
    return null;
  }
}

export async function getLanguages(repo: string): Promise<Record<string, number>> {
  if (!githubConfigured()) return {};
  try {
    return (await ghFetch(`/repos/${repo}/languages`)) ?? {};
  } catch {
    return {};
  }
}

// ── Read helpers for the dev-pod CI loop (not tools; exported functions) ──────

export async function getBranch(repo: string, branch: string): Promise<{ exists: boolean; sha?: string }> {
  if (!githubConfigured()) return { exists: false };
  try {
    const resp = await ghFetch(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    return { exists: true, sha: resp?.commit?.sha };
  } catch {
    return { exists: false };
  }
}

export async function getLatestWorkflowRun(
  repo: string,
  branch: string,
  workflow?: string,
): Promise<{ id: number; status: string; conclusion: string | null; html_url: string; name: string } | null> {
  if (!githubConfigured()) return null;
  const path = workflow
    ? `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=1`
    : `/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
  const resp = await ghFetch(path);
  const run = resp?.workflow_runs?.[0];
  return run ? { id: run.id, status: run.status, conclusion: run.conclusion ?? null, html_url: run.html_url, name: run.name } : null;
}

// Branch-vs-base compare stats for the PR-stage diff-size guard.
export async function getCompareStats(repo: string, base: string, head: string): Promise<{ files: number; paths: string[] } | null> {
  if (!githubConfigured()) return null;
  try {
    const resp = await ghFetch(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`);
    const files = (resp?.files ?? []) as any[];
    return { files: Number(resp?.total_files ?? files.length), paths: files.map((f) => String(f.filename)) };
  } catch {
    return null;
  }
}

// Failed-job excerpt for the repair loop: job names + failed step names.
export async function getWorkflowRunFailureExcerpt(repo: string, runId: number): Promise<string> {
  if (!githubConfigured()) return '';
  try {
    const resp = await ghFetch(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`);
    const lines: string[] = [];
    for (const job of resp?.jobs ?? []) {
      if (job.conclusion === 'failure') {
        const steps = (job.steps ?? []).filter((s: any) => s.conclusion === 'failure').map((s: any) => s.name);
        lines.push(`Job "${job.name}" failed${steps.length ? ` at step(s): ${steps.join(', ')}` : ''}`);
      }
    }
    return lines.join('\n').slice(0, 2000);
  } catch {
    return '';
  }
}
