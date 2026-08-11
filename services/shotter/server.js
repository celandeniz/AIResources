// DynOps Shotter — authenticated D365 screenshot sidecar.
// POST /shoot { baseUrl, mi?, cmp?, user, password, stateKey, caption? }
//   → logs into the customer environment as the given UI service user
//     (Entra username/password form flow; session persisted per stateKey so
//     login happens once), navigates to the deep link
//     {baseUrl}/?cmp={cmp}&mi={mi}, waits for the app to settle and returns
//     a JPEG screenshot as base64.
// Auth: x-internal-token (same shared secret as the platform's internal calls).
// The playwright base image ships the browsers; this stays a thin HTTP shim.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 4600);
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal-token';
const STATE_DIR = process.env.STATE_DIR || '/state';
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT_MS || 90_000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 6_000);

fs.mkdirSync(STATE_DIR, { recursive: true });

const app = express();
const shootJson = express.json({ limit: '1mb' });
const renderJson = express.json({ limit: '50mb' });

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// One request at a time — screenshots are rare and browsers are heavy.
let busy = false;

app.post('/shoot', shootJson, async (req, res) => {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, detail: 'unauthorized' });
  }
  // Two auth modes:
  //  1) storageState (donated session, preferred): no credentials needed; on
  //     an expired session we return code:'session_expired' (no login attempt).
  //  2) user+password: automated Entra form login (MFA'sız hesap gerekir).
  // `url` (WS6): a full target URL built AND origin-validated by the API
  // (SSRF guard lives there) — used verbatim. Legacy baseUrl+cmp+mi kept for
  // F&O deep links.
  const { url, baseUrl, mi, cmp, user, password, stateKey, fullPage, storageState } = req.body || {};
  if ((!url && !baseUrl) || !stateKey || (!storageState && (!user || !password))) {
    return res.status(400).json({ ok: false, detail: '(url VEYA baseUrl), stateKey ve (storageState VEYA user+password) zorunlu' });
  }
  if (busy) return res.status(429).json({ ok: false, detail: 'shotter meşgul — tekrar deneyin' });
  busy = true;

  const statePath = path.join(STATE_DIR, `${String(stateKey).replace(/[^a-z0-9-]/gi, '_')}.json`);
  const target = url
    ? String(url)
    : `${String(baseUrl).replace(/\/$/, '')}/?${[cmp && `cmp=${encodeURIComponent(cmp)}`, mi && `mi=${encodeURIComponent(mi)}`].filter(Boolean).join('&')}`;

  let browser;
  try {
    // A freshly donated session overrides the local file cache.
    if (storageState) {
      fs.writeFileSync(statePath, typeof storageState === 'string' ? storageState : JSON.stringify(storageState));
    }
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      storageState: fs.existsSync(statePath) ? statePath : undefined,
      locale: 'tr-TR',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Entra login flow if we got bounced to login.microsoftonline.com.
    // Session mode never types credentials — an expired session is reported
    // so the platform can ask the owner to re-authorize.
    if (/login\.microsoftonline\.com|login\.live\.com/.test(page.url()) && (!user || !password)) {
      await browser.close();
      busy = false;
      return res.json({ ok: false, code: 'session_expired', detail: 'Bağışlanan oturum süresi dolmuş — yeniden yetkilendirme gerekli (scripts/env-login.mjs).' });
    }
    if (/login\.microsoftonline\.com|login\.live\.com/.test(page.url())) {
      await page.fill('input[name="loginfmt"]', user);
      await page.click('input[type="submit"], #idSIButton9');
      await page.waitForTimeout(2500);
      // Password screen (may be skipped for federated tenants — then we fail clearly).
      const pwd = page.locator('input[name="passwd"]');
      await pwd.waitFor({ state: 'visible', timeout: 20_000 });
      await pwd.fill(password);
      await page.click('input[type="submit"], #idSIButton9');
      await page.waitForTimeout(3000);
      // "Stay signed in?" (KMSI)
      const kmsi = page.locator('#idSIButton9');
      if (await kmsi.isVisible().catch(() => false)) {
        await kmsi.click().catch(() => {});
      }
      await page.waitForURL((u) => !/login\.microsoftonline\.com/.test(String(u)), { timeout: NAV_TIMEOUT }).catch(() => {});
      // Re-navigate to the deep link post-login (some tenants land on home).
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }

    // Let the D365 shell render (async form loading).
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    if (/login\.microsoftonline\.com/.test(page.url())) {
      throw new Error('Giriş tamamlanamadı (MFA/koşullu erişim olabilir) — MFA istemeyen bir servis kullanıcısı gerekir.');
    }

    const image = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: Boolean(fullPage) });
    // Persist the (refreshed) session and hand it back so the platform can
    // re-encrypt + store it — the donated session SLIDES with each use.
    const refreshedState = await context.storageState({ path: statePath });
    const title = await page.title().catch(() => '');
    await browser.close();
    busy = false;
    return res.json({ ok: true, image: image.toString('base64'), title, bytes: image.length, storageState: refreshedState });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    busy = false;
    return res.json({ ok: false, detail: String(e && e.message ? e.message : e).slice(0, 500) });
  }
});

app.post('/render-drawio', renderJson, async (req, res) => {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, detail: 'unauthorized' });
  }
  const { xml } = req.body || {};
  if (typeof xml !== 'string' || !xml.trim()) {
    return res.status(400).json({ ok: false, detail: 'xml zorunlu' });
  }
  if (busy) return res.status(429).json({ ok: false, detail: 'shotter meşgul — tekrar deneyin' });
  busy = true;

  let browser;
  try {
    const graphConfig = escapeHtml(JSON.stringify({
      highlight: '#0000ff',
      nav: true,
      resize: true,
      toolbar: 'zoom layers lightbox',
      edit: '_blank',
      xml,
    }));
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>html,body{margin:0;padding:0;background:#fff}.mxgraph{display:inline-block}</style>
</head>
<body>
  <div class="mxgraph" data-mxgraph='${graphConfig}'></div>
  <script src="https://viewer.diagrams.net/js/viewer.min.js"></script>
</body>
</html>`;

    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const diagram = await page.waitForSelector('.mxgraph svg', { timeout: 30_000 });
    const png = await diagram.screenshot({ type: 'png' });
    return res.json({ ok: true, png: png.toString('base64') });
  } catch (e) {
    return res.status(500).json({ ok: false, detail: String(e && e.message ? e.message : e).slice(0, 500) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    busy = false;
  }
});

app.post('/render-pdf', renderJson, async (req, res) => {
  if (req.headers['x-internal-token'] !== INTERNAL_TOKEN) {
    return res.status(401).json({ ok: false, detail: 'unauthorized' });
  }
  const { html, footerLeft } = req.body || {};
  if (typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ ok: false, detail: 'html zorunlu' });
  }
  if (busy) return res.status(429).json({ ok: false, detail: 'shotter meşgul — tekrar deneyin' });
  busy = true;

  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page
      .waitForFunction('window.__docReady === true', undefined, { timeout: 45_000 })
      .catch(() => page.waitForTimeout(2_000));

    const footerTemplate = '<div style="font-size:9px;width:100%;padding:0 12mm;display:flex;justify-content:space-between">'
      + `<span>${escapeHtml(footerLeft ?? '')}</span>`
      + '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>'
      + '</div>';
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margin: { top: '18mm', bottom: '16mm', left: '12mm', right: '12mm' },
      footerTemplate,
      headerTemplate: '<span></span>',
    });
    res.type('application/pdf');
    return res.send(pdf);
  } catch (e) {
    return res.status(500).json({ ok: false, detail: String(e && e.message ? e.message : e).slice(0, 500) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    busy = false;
  }
});

app.listen(PORT, () => console.log(`[shotter] listening on :${PORT} (state: ${STATE_DIR})`));
