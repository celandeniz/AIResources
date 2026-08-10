// Secret-at-rest encryption for customer environment credentials.
// AES-256-GCM with a master key from CRED_MASTER_KEY (32+ char random string).
// Format: base64(iv):base64(authTag):base64(ciphertext). Fail-closed: without
// a master key, encryption/decryption refuse (secrets are never stored plain).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function masterKey(): Buffer | null {
  const raw = process.env.CRED_MASTER_KEY;
  if (!raw || raw.length < 16) return null;
  return createHash('sha256').update(raw).digest(); // normalize to 32 bytes
}

export function credCryptoReady(): boolean {
  return masterKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key) throw new Error('CRED_MASTER_KEY not set — refusing to store a plaintext secret');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const key = masterKey();
  if (!key) throw new Error('CRED_MASTER_KEY not set — cannot decrypt');
  const [ivB64, tagB64, dataB64] = stored.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
