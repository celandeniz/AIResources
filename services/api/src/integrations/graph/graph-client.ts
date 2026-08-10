import { Logger } from '@nestjs/common';

// Microsoft Graph app-only (client credentials) client.
// Token is cached in-process and refreshed shortly before expiry.
// Credentials come from env (Key Vault in prod), never from the DB.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const logger = new Logger('GraphClient');

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let cached: CachedToken | null = null;

export function graphConfigured(): boolean {
  return Boolean(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET);
}

export async function getGraphToken(): Promise<string> {
  if (!graphConfigured()) throw new Error('Graph not configured (set GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET)');
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const tenant = process.env.GRAPH_TENANT_ID!;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID!,
    client_secret: process.env.GRAPH_CLIENT_SECRET!,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token ${res.status}: ${text}`);
  }
  const data: any = await res.json();
  cached = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3500) * 1000 };
  logger.log('Acquired Graph app-only token');
  return cached.token;
}

// Thrown on sustained Graph throttling — callers (coverage crawler) skip the
// mailbox for the current tick instead of erroring the integration row.
export class GraphThrottledError extends Error {
  constructor(url: string) {
    super(`Graph throttled (429) at ${url}`);
    this.name = 'GraphThrottledError';
  }
}

// Accepts a path ("/users/...") or a full URL (delta/next links from Graph).
// On 429 the Retry-After header is honored once (bounded); a repeat 429 throws
// GraphThrottledError.
export async function graphFetch(pathOrUrl: string, init: RequestInit = {}): Promise<any> {
  const token = await getGraphToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status !== 429) break;
    if (attempt === 0) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 5);
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(retryAfter) ? retryAfter : 5, 30) * 1000));
    }
  }
  if (!res) throw new Error('graphFetch: no response');
  if (res.status === 429) throw new GraphThrottledError(url.replace(GRAPH_BASE, ''));
  if (res.status === 202 || res.status === 204) return { ok: true, status: res.status };
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? text;
    throw new Error(`Graph ${res.status} ${url.replace(GRAPH_BASE, '')}: ${msg}`);
  }
  return json;
}

// Generalized @odata.nextLink pager: collects `value` entries up to `cap`.
export async function pagedGraphFetch(pathOrUrl: string, opts?: { cap?: number; maxPages?: number }): Promise<any[]> {
  const cap = opts?.cap ?? 200;
  const maxPages = opts?.maxPages ?? 20;
  const out: any[] = [];
  let url: string | undefined = pathOrUrl;
  for (let page = 0; page < maxPages && url && out.length < cap; page++) {
    const data: any = await graphFetch(url);
    for (const v of data.value ?? []) {
      out.push(v);
      if (out.length >= cap) break;
    }
    url = data['@odata.nextLink'];
  }
  return out;
}
