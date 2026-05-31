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

// Accepts a path ("/users/...") or a full URL (delta/next links from Graph).
export async function graphFetch(pathOrUrl: string, init: RequestInit = {}): Promise<any> {
  const token = await getGraphToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
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
