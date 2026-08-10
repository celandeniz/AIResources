#!/usr/bin/env node
// Ortam oturumu bağışlama — "bir kez izin ver, platform kendi devam etsin".
//
// Ne yapar: kendi makinenizde GÖRÜNÜR bir tarayıcı açar, müşteri D365
// ortamına SİZ giriş yaparsınız (MFA dahil — şifreniz hiçbir yere yazılmaz),
// giriş tamamlanınca tarayıcı oturumunu (çerezleri) alır ve platforma
// şifrelenerek saklanmak üzere gönderir. O andan itibaren ekran görüntülü
// doküman üretimi bu oturumla otomatik çalışır; her kullanımda oturum
// kendini yeniler, süresi dolarsa platform bildirimle tekrar ister.
//
// Kullanım:
//   node scripts/env-login.mjs                → ortamları listeler
//   node scripts/env-login.mjs <environmentId>
//
// Gereksinim: npx playwright (ilk çalıştırmada chromium'u indirir).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';
const EMAIL = process.env.DYNOPS_ADMIN_EMAIL ?? 'deniz@dynamicsops.com';

async function login() {
  const res = await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, role: 'admin' }),
  });
  if (!res.ok) throw new Error(`dev-login ${res.status}`);
  return (await res.json()).accessToken;
}

async function main() {
  const token = await login();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const envs = await fetch(`${API}/api/v1/environments`, { headers }).then((r) => r.json());
  const envId = process.argv[2];
  if (!envId) {
    console.log('Ortamlar:');
    for (const e of envs) console.log(`  ${e.id}  [${e.kind}] ${e.name}  ${e.base_url ?? ''}  session:${e.has_session ? '✓' : '—'}`);
    console.log('\nKullanım: node scripts/env-login.mjs <environmentId>');
    return;
  }
  const env = envs.find((e) => e.id === envId);
  if (!env) throw new Error('ortam bulunamadı');
  // login_url is built server-side per kind: fno/web → base_url; bc → the
  // tenant-specific BC web client (businesscentral.dynamics.com/{tenant}/{env}).
  const url = env.login_url ?? env.base_url ?? 'https://businesscentral.dynamics.com/';
  console.log(`\n🖥  Tarayıcı açılıyor → ${url}`);
  console.log('   Girişinizi (MFA dahil) tamamlayın; D365 ekranı yüklendiğinde oturum otomatik alınacak.\n');

  // Playwright'ı repo dışında bağımsız bir dizine kur (pnpm monorepo ile
  // çakışmasın) ve oradan yükle.
  const toolDir = join(homedir(), '.dynops-envlogin');
  const pwPkg = join(toolDir, 'node_modules', 'playwright');
  if (!existsSync(pwPkg)) {
    console.log(`Playwright kuruluyor (tek seferlik) → ${toolDir}`);
    mkdirSync(toolDir, { recursive: true });
    spawnSync('npm', ['install', '--prefix', toolDir, 'playwright@1.49.1'], { stdio: 'inherit' });
    spawnSync('node', [join(pwPkg, 'cli.js'), 'install', 'chromium'], { stdio: 'inherit' });
  }
  const requireFrom = createRequire(join(toolDir, 'package.json'));
  const { chromium } = requireFrom('playwright');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'tr-TR' });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Giriş bitene kadar bekle: login.microsoftonline.com'dan çıkıp hedef
  // domain'e oturmuş ve sayfa yüklenmiş olmalı (en fazla 10 dk).
  const targetHost = new URL(url).host;
  await page.waitForURL((u) => String(u).includes(targetHost) && !/login\.microsoftonline\.com/.test(String(u)), { timeout: 600_000 });
  await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const storageState = await context.storageState();
  await browser.close();

  const r = await fetch(`${API}/api/v1/environments/${envId}/session`, {
    method: 'POST', headers, body: JSON.stringify({ storageState }),
  }).then((x) => x.json());
  if (!r.ok) throw new Error(r.detail ?? 'oturum kaydedilemedi');
  console.log(`\n✅ Oturum platforma bağışlandı (${r.cookies} çerez, şifreli saklandı).`);
  console.log('   Ekran görüntülü doküman üretimi artık otomatik çalışır; oturum her kullanımda yenilenir.');
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
