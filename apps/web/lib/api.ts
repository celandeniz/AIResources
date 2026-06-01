'use client';

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('dynops_token');
}
export function setToken(t: string) {
  localStorage.setItem('dynops_token', t);
}
export function getUser(): any | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('dynops_user');
  return raw ? JSON.parse(raw) : null;
}
export function setUser(u: any) {
  localStorage.setItem('dynops_user', JSON.stringify(u));
}
export function logout() {
  localStorage.removeItem('dynops_token');
  localStorage.removeItem('dynops_user');
  localStorage.removeItem('dynops_workspace');
}

export function getWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('dynops_workspace');
}
export function setWorkspaceId(id: string) {
  localStorage.setItem('dynops_workspace', id);
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const ws = getWorkspaceId();
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ws ? { 'x-workspace': ws } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    // Expired/invalid session → self-heal instead of silently rendering blank
    // pages: clear the stale token and bounce to login (avoid a redirect loop).
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      logout();
      window.location.href = '/login';
    }
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  return (ct.includes('application/json') ? await res.json() : (await res.text())) as T;
}

export function apiStreamUrl(path = '/stream') {
  const token = getToken();
  const ws = getWorkspaceId();
  const url = new URL(`${BASE}/api/v1${path}`);
  if (token) url.searchParams.set('access_token', token);
  if (ws) url.searchParams.set('workspace', ws);
  return url.toString();
}

export async function devLogin(email: string, role: string) {
  const res = await fetch(`${BASE}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
