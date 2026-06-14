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

      return { ok: false, detail: `GitHubAdapter cannot execute ${tool}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

export const gitHubAdapter = new GitHubAdapter();
