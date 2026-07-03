import { createSign } from 'crypto';
import { Logger } from '@nestjs/common';

// Firebase Cloud Messaging HTTP v1 client. Auth = OAuth2 service-account JWT
// (RS256 via node crypto — no googleapis dependency). FAIL-CLOSED: with no
// FCM_SERVICE_ACCOUNT_JSON, sendFcm logs a mock line and reports 'ok'.
const logger = new Logger('Fcm');

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let sa: ServiceAccount | null | undefined; // undefined = env not parsed yet
let cached: { token: string; expiresAt: number } | null = null;

export function fcmConfigured(): boolean {
  if (sa === undefined) {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON ?? '';
    try { sa = raw ? (JSON.parse(raw) as ServiceAccount) : null; } catch { sa = null; }
  }
  return Boolean(sa?.project_id && sa?.client_email && sa?.private_key);
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) return cached.token;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: sa!.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa!.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  cached = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3500) };
  return cached.token;
}

export async function sendFcm(
  deviceToken: string,
  notification: { title: string; body: string },
  data: Record<string, string>,
): Promise<'ok' | 'unregistered' | 'error'> {
  if (!fcmConfigured()) {
    logger.log(`(mock) push → "${notification.title}" [${data.type ?? '?'}:${data.id ?? '?'}]`);
    return 'ok';
  }
  try {
    const token = await accessToken();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa!.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: deviceToken, notification, data } }),
    });
    if (res.status === 404 || res.status === 410) return 'unregistered';
    if (!res.ok) {
      logger.warn(`FCM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return 'error';
    }
    return 'ok';
  } catch (e) {
    logger.warn(`FCM send failed: ${(e as Error).message}`);
    return 'error';
  }
}
