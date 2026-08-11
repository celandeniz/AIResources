// Customer D365 environment registry — secure automatic connectivity to
// Business Central AND Finance & SCM tenants.
//  - Credentials: per-environment Entra app (tenant/client/secret), secret
//    AES-256-GCM encrypted at rest, write-only through the API, every
//    decryption audited. READ-ONLY usage by design (discovery + doc context).
//  - Probe: acquires a client-credentials token and discovers companies /
//    reachability (BC api/v2.0 companies; F&O OData LegalEntities).
//  - buildEnvironmentContext(): compact factual block about the customer's
//    REAL environments, injected into doc/brief generation so the AI behaves
//    like a senior consultant who knows the tenant.

import { Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { AuditModule, AuditService } from '../../common/audit.service';
import { credCryptoReady, decryptSecret, encryptSecret } from '../../common/crypto';

interface ProbeResult {
  ok: boolean;
  detail: string;
  companies?: { id?: string; name: string }[];
  extra?: Record<string, unknown>;
}

async function entraToken(tenantId: string, clientId: string, secret: string, scope: string): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, scope, grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Entra token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json() as any).access_token;
}

@Injectable()
export class EnvironmentsService {
  private readonly logger = new Logger('Environments');
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async probe(envId: string): Promise<ProbeResult> {
    const env = await (this.prisma as any).customer_environments.findUnique({ where: { id: envId } });
    if (!env) return { ok: false, detail: 'ortam bulunamadı' };

    let result: ProbeResult;
    if (env.kind === 'web') {
      // Web app: reachability-only probe — no Entra app registration needed.
      try {
        result = await this.probeWeb(env);
      } catch (e) {
        result = { ok: false, detail: (e as Error).message.slice(0, 500) };
      }
    } else {
      if (!env.secret_encrypted) return { ok: false, detail: 'client secret kaydedilmemiş' };
      let secret: string;
      try {
        secret = decryptSecret(env.secret_encrypted);
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
      await this.audit.log({ actorType: 'system', action: 'execute', entityType: 'customer_environments', entityId: envId, summary: `Environment probe (${env.kind}): secret decrypted for connectivity test` });
      try {
        result = env.kind === 'bc'
          ? await this.probeBc(env, secret)
          : await this.probeFno(env, secret);
      } catch (e) {
        result = { ok: false, detail: (e as Error).message.slice(0, 500) };
      }
    }

    await (this.prisma as any).customer_environments.update({
      where: { id: envId },
      data: {
        status: result.ok ? 'connected' : 'error',
        last_probe_at: new Date(),
        last_error: result.ok ? null : result.detail,
        ...(result.ok
          ? { metadata: { ...((env.metadata as any) ?? {}), companies: result.companies ?? [], ...(result.extra ?? {}), discovered_at: new Date().toISOString() } }
          : {}),
      },
    });
    return result;
  }

  // BC: https://api.businesscentral.dynamics.com/v2.0/{tenant}/{environment}/api/v2.0/companies
  private async probeBc(env: any, secret: string): Promise<ProbeResult> {
    const token = await entraToken(env.tenant_id, env.client_id, secret, 'https://api.businesscentral.dynamics.com/.default');
    const environment = env.base_url || 'Production';
    const res = await fetch(
      `https://api.businesscentral.dynamics.com/v2.0/${env.tenant_id}/${encodeURIComponent(environment)}/api/v2.0/companies`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`BC companies ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const companies = (data.value ?? []).map((c: any) => ({ id: c.id, name: c.displayName ?? c.name }));

    // Best-effort installed-extension discovery (Automation API) — the ISV
    // list of the tenant. 403/404 = permission not granted → skip silently
    // (ISVs then come from repo profiling / manual entry).
    let extensions: { displayName: string; publisher?: string; version?: string; isInstalled: boolean }[] = [];
    const first = companies[0];
    if (first?.id) {
      try {
        const extRes = await fetch(
          `https://api.businesscentral.dynamics.com/v2.0/${env.tenant_id}/${encodeURIComponent(environment)}/api/microsoft/automation/v2.0/companies(${first.id})/extensions`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (extRes.ok) {
          const ext: any = await extRes.json();
          extensions = (ext.value ?? [])
            .filter((x: any) => x.isInstalled !== false)
            .map((x: any) => ({
              displayName: String(x.displayName ?? '?'),
              publisher: x.publisher ? String(x.publisher) : undefined,
              version: [x.versionMajor, x.versionMinor].filter((v: any) => v != null).join('.') || undefined,
              isInstalled: true,
            }))
            .slice(0, 40);
        }
      } catch { /* best-effort */ }
    }
    return {
      ok: true,
      detail: `BC OK — ${companies.length} şirket${extensions.length ? `, ${extensions.length} yüklü uzantı` : ''}`,
      companies,
      ...(extensions.length ? { extra: { extensions } } : {}),
    };
  }

  // Web app: GET base_url; 2xx/3xx = reachable. A redirect to Entra login
  // means the donated session can authenticate screenshots later.
  private async probeWeb(env: any): Promise<ProbeResult> {
    const base = String(env.base_url ?? '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('Web uygulaması için base_url zorunlu (https://…)');
    const res = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const loc = res.headers.get('location') ?? '';
    const entra = /login\.microsoftonline\.com/i.test(loc);
    if (res.status >= 200 && res.status < 400) {
      return {
        ok: true,
        detail: entra ? 'Web OK — Entra korumalı (ekran görüntüsü için oturum bağışlayın)' : `Web OK — HTTP ${res.status}`,
        companies: [],
        extra: { entra_protected: entra },
      };
    }
    throw new Error(`Web probe HTTP ${res.status}`);
  }

  // F&O: {base}/data/LegalEntities (OData, cross-company). No $select — the
  // property set varies (LegalEntityId vs dataAreaId across versions); map
  // whatever identifier the payload carries.
  private async probeFno(env: any, secret: string): Promise<ProbeResult> {
    const base = String(env.base_url ?? '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('F&O için base_url zorunlu (https://xxx.operations.dynamics.com)');
    const token = await entraToken(env.tenant_id, env.client_id, secret, `${base}/.default`);
    const res = await fetch(`${base}/data/LegalEntities?cross-company=true&$top=50`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`F&O LegalEntities ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const companies = (data.value ?? []).map((c: any) => {
      const id = c.LegalEntityId ?? c.dataAreaId ?? c.DataArea ?? c.Company ?? c.CompanyCode ?? null;
      return { id, name: c.Name ?? c.NameAlias ?? id ?? '?' };
    });
    return { ok: true, detail: `F&O OK — ${companies.length} tüzel kişilik`, companies, extra: { base_url: base } };
  }
}

// ── Authenticated screenshot capture via the shotter sidecar ─────────────────
// Multi-platform (WS6): each shot declares its platform (fno | bc | web,
// default fno for legacy plans); the matching environment row is picked per
// shot (project-scoped rows win over customer-wide ones). Best-effort: any
// failure returns [] / skips the shot — doc generation continues with
// placeholders.
export interface ShotSpec {
  platform?: 'fno' | 'bc' | 'web';
  mi?: string; cmp?: string;                 // fno deep link
  page?: string | number; company?: string;  // bc web client
  path?: string;                             // web app route
  caption: string;
}

// SSRF guard: shot URLs are built HERE ONLY, and the result's origin must
// match the environment's trusted origin (admin-configured base_url, or the
// fixed BC web-client host). Model-provided values contribute nothing but
// query/route fragments — they can never steer the browser to another host.
export function buildShotUrl(env: { kind: string; base_url?: string | null; tenant_id?: string }, shot: ShotSpec): string | null {
  try {
    if (env.kind === 'fno') {
      const base = String(env.base_url ?? '').replace(/\/$/, '');
      if (!/^https:\/\//.test(base)) return null;
      const qs = [shot.cmp && `cmp=${encodeURIComponent(shot.cmp)}`, shot.mi && `mi=${encodeURIComponent(shot.mi)}`].filter(Boolean).join('&');
      const url = `${base}/?${qs}`;
      return new URL(url).origin === new URL(base).origin ? url : null;
    }
    if (env.kind === 'bc') {
      // BC web client lives on businesscentral.dynamics.com (NOT the API host);
      // base_url holds the ENVIRONMENT NAME for bc rows.
      const envName = String(env.base_url || 'Production');
      const page = String(shot.page ?? '').replace(/[^0-9]/g, '');
      const qs = [shot.company && `company=${encodeURIComponent(shot.company)}`, page && `page=${page}`].filter(Boolean).join('&');
      const url = `https://businesscentral.dynamics.com/${encodeURIComponent(String(env.tenant_id ?? ''))}/${encodeURIComponent(envName)}${qs ? `?${qs}` : ''}`;
      return new URL(url).origin === 'https://businesscentral.dynamics.com' ? url : null;
    }
    if (env.kind === 'web') {
      const base = String(env.base_url ?? '').replace(/\/$/, '');
      if (!/^https:\/\//.test(base)) return null;
      const path = String(shot.path ?? '/');
      if (!path.startsWith('/') || path.startsWith('//')) return null;
      const url = new URL(path, `${base}/`).toString();
      return new URL(url).origin === new URL(base).origin ? url : null;
    }
  } catch { /* malformed input → no shot */ }
  return null;
}

export async function captureEnvironmentShots(
  prisma: PrismaService,
  customerId: string | null | undefined,
  shots: ShotSpec[],
  projectId?: string | null,
): Promise<{ caption: string; dataUri: string }[]> {
  if (!customerId || !shots.length) return [];
  const shotterUrl = process.env.SHOTTER_URL ?? 'http://shotter:4600';
  try {
    // All authable environments of the customer; per-shot selection prefers a
    // DONATED SESSION over a service-account password, and a project-scoped
    // row over a customer-wide one.
    const envRows = await (prisma as any).customer_environments.findMany({
      where: {
        customer_id: customerId, status: 'connected',
        OR: [{ ui_session_encrypted: { not: null } }, { ui_user: { not: null } }],
      },
      orderBy: [{ ui_session_encrypted: 'desc' }, { created_at: 'asc' }],
    });
    if (!envRows.length) return [];
    const pickEnv = (platform?: string) => {
      const kind = platform ?? 'fno';
      const c = envRows.filter((e: any) => e.kind === kind);
      return (projectId && c.find((e: any) => e.project_id === projectId)) ?? c.find((e: any) => !e.project_id) ?? c[0] ?? null;
    };

    // Per-environment auth (decrypted once, then slid forward on every
    // successful shot — the shotter requires auth on every call).
    const authCache = new Map<string, Record<string, unknown>>();
    const authFor = (env: any): Record<string, unknown> | null => {
      if (authCache.has(env.id)) return authCache.get(env.id)!;
      const auth: Record<string, unknown> = {};
      try {
        if (env.ui_session_encrypted) auth.storageState = JSON.parse(decryptSecret(env.ui_session_encrypted));
        else if (env.ui_password_encrypted && env.ui_user) { auth.user = env.ui_user; auth.password = decryptSecret(env.ui_password_encrypted); }
        else return null;
      } catch { return null; }
      authCache.set(env.id, auth);
      return auth;
    };

    const out: { caption: string; dataUri: string }[] = [];
    const expired = new Set<string>();
    for (const shot of shots.slice(0, 6)) {
      const env = pickEnv(shot.platform);
      if (!env || expired.has(env.id)) continue;
      const url = buildShotUrl(env, shot);
      const auth = url ? authFor(env) : null;
      if (!url || !auth) continue;

      // Slow sandbox forms: generous window + one retry per screen (the retry
      // benefits from the already-warmed session/cache in the shotter).
      let res: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch(`${shotterUrl}/shoot`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN ?? 'dev-internal-token' },
          body: JSON.stringify({ url, stateKey: env.id, ...auth }),
          signal: AbortSignal.timeout(300_000),
        }).then((r) => r.json() as Promise<any>).catch((e) => ({ ok: false, detail: (e as Error).message }));
        if (res?.ok || res?.code === 'session_expired') break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      if (res?.ok && res.image) {
        out.push({ caption: shot.caption, dataUri: `data:image/jpeg;base64,${res.image}` });
        // Sliding renewal: persist the refreshed session after every success
        // AND keep sending it on subsequent calls for this environment.
        if (res.storageState && env.ui_session_encrypted) {
          await (prisma as any).customer_environments.update({
            where: { id: env.id },
            data: { ui_session_encrypted: encryptSecret(JSON.stringify(res.storageState)), ui_session_saved_at: new Date() },
          }).catch(() => {});
          authCache.set(env.id, { storageState: res.storageState });
        }
      } else if (res?.code === 'session_expired') {
        // Ask the owner to re-authorize — one notification per environment,
        // then stop trying that environment (others may still work).
        expired.add(env.id);
        await (prisma as any).notifications.create({
          data: {
            workspace_id: env.workspace_id,
            type: 'env_session_expired',
            title: 'Ortam oturumu süresi doldu',
            message: `${env.name}: ekran görüntüsü oturumu geçersiz — 'node scripts/env-login.mjs ${env.id}' ile yeniden yetkilendirin.`,
            metadata: { environmentId: env.id },
          },
        }).catch(() => {});
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Compact factual context about a customer's environments — injected into doc
// generation / briefs so outputs reference the REAL tenant (companies, urls).
// With projectId, the project's TECH STACK (platforms, custom apps from repo
// profiles, ISVs, web framework) is appended as a ÇÖZÜM YIĞINI block.
export const PLATFORM_LABEL: Record<string, string> = {
  bc: 'D365 Business Central', 'bc-al': 'D365 Business Central',
  fno: 'D365 Finance & SCM', 'fno-xpp': 'D365 Finance & SCM',
  web: 'Web Uygulaması',
};

export async function buildEnvironmentContext(prisma: PrismaService, customerId?: string | null, projectId?: string | null): Promise<string> {
  if (!customerId && !projectId) return '';
  try {
    const envs = customerId
      ? await (prisma as any).customer_environments.findMany({
          where: { customer_id: customerId },
          select: { kind: true, name: true, base_url: true, status: true, metadata: true },
        })
      : [];
    const parts: string[] = [];
    if (envs.length) {
      const lines = envs.map((e: any) => {
        const meta = (e.metadata as any) ?? {};
        const companies = (meta.companies ?? []).map((c: any) => c.name).slice(0, 10);
        const sys = PLATFORM_LABEL[e.kind] ?? e.kind;
        const loc = e.kind === 'bc' ? `environment: ${e.base_url ?? 'Production'}` : `url: ${e.base_url ?? '?'}`;
        return `- ${sys} — ${e.name} (${loc}; durum: ${e.status})${companies.length ? ` — şirketler: ${companies.join(', ')}` : ''}`;
      });
      parts.push(`=== MÜŞTERİ ORTAMLARI (gerçek, keşfedilmiş) ===\n${lines.join('\n')}\nDokümanda ortam/şirket adı gereken yerlerde BU gerçek değerleri kullan.`);
    }

    if (projectId) {
      const project = await (prisma as any).projects.findUnique({
        where: { id: projectId },
        select: { repos: true, isvs: true, metadata: true },
      });
      if (project) {
        const repos = ((project.repos as any[]) ?? []);
        const isvs = ((project.isvs as any[]) ?? []);
        const profiles = (((project.metadata as any)?.repo_profile?.repos ?? []) as any[]);
        const platforms = new Set<string>();
        for (const r of repos) if (PLATFORM_LABEL[r.kind]) platforms.add(PLATFORM_LABEL[r.kind]);
        for (const e of envs) if (PLATFORM_LABEL[e.kind]) platforms.add(PLATFORM_LABEL[e.kind]);
        const appLines = profiles.flatMap((p: any) => (p.apps ?? []).map((a: any) =>
          `  - ${a.name}${a.publisher ? ` (${a.publisher}${a.version ? ` ${a.version}` : ''})` : ''}`));
        const models = profiles.flatMap((p: any) => p.models ?? []);
        const frameworks = [...new Set(profiles.map((p: any) => p.framework).filter(Boolean))];
        const stackLines = [
          platforms.size ? `Platformlar: ${[...platforms].join(', ')}` : null,
          repos.length ? `Repolar: ${repos.map((r: any) => `${r.repo} [${r.kind}]`).join(', ')}` : null,
          appLines.length ? `Özel uygulamalar (repo'dan):\n${appLines.join('\n')}` : null,
          models.length ? `X++ modelleri: ${models.slice(0, 10).join(', ')}` : null,
          frameworks.length ? `Web framework: ${frameworks.join(', ')}` : null,
          isvs.length ? `ISV çözümleri: ${isvs.slice(0, 20).map((i: any) => `${i.name}${i.publisher ? ` (${i.publisher})` : ''}`).join(', ')}` : null,
        ].filter(Boolean);
        if (stackLines.length) {
          parts.push(`=== ÇÖZÜM YIĞINI (projenin teknoloji bileşenleri) ===\n${stackLines.join('\n')}\nDokümanın 'Çözüm Bileşenleri' bölümünde bu platform/özel uygulama/ISV bilgisini kullan; süreç bu bileşenlere değiyorsa adım anlatımında belirt.`);
        }
      }
    }
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

@Controller('environments')
export class EnvironmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: EnvironmentsService,
    private readonly audit: AuditService,
  ) {}

  // Secrets are NEVER serialized out (has_secret flag only); tenant/client ids
  // are masked to prefixes in list output (full values are write-only).
  // Workspace isolation comes from the Prisma tenant middleware
  // (customer_environments ∈ TENANT_MODELS).
  private redact(row: any) {
    const { secret_encrypted, tenant_id, client_id, ui_password_encrypted, ui_session_encrypted, ...rest } = row;
    const mask = (v?: string | null) => (v ? `${String(v).slice(0, 8)}…` : null);
    // login_url: where a browser session for THIS environment must be donated
    // (BC web client is a different host than the BC API). Tenant id appears
    // here only as a URL path segment — it is a public identifier; the
    // credential material stays write-only.
    const loginUrl =
      row.kind === 'bc'
        ? `https://businesscentral.dynamics.com/${encodeURIComponent(String(tenant_id ?? ''))}/${encodeURIComponent(String(row.base_url || 'Production'))}`
        : (row.base_url ?? null);
    return {
      ...rest,
      tenant_id: mask(tenant_id),
      client_id: mask(client_id),
      login_url: loginUrl,
      has_secret: Boolean(secret_encrypted),
      has_ui_user: Boolean(row.ui_user && ui_password_encrypted),
      has_session: Boolean(ui_session_encrypted),
    };
  }

  @Roles('manager')
  @Get()
  async list(@Query('customerId') customerId?: string) {
    const rows = await (this.prisma as any).customer_environments.findMany({
      where: customerId ? { customer_id: customerId } : {},
      orderBy: [{ customer_id: 'asc' }, { kind: 'asc' }],
    });
    return rows.map((r: any) => this.redact(r));
  }

  @Get('crypto-status')
  cryptoStatus() {
    return { ready: credCryptoReady(), hint: credCryptoReady() ? null : 'CRED_MASTER_KEY env değişkenini ayarlayın' };
  }

  @Roles('admin')
  @Post()
  async create(@Body() body: { customer_id: string; project_id?: string; kind: 'bc' | 'fno' | 'web'; name: string; base_url?: string; tenant_id?: string; client_id?: string; client_secret?: string }) {
    // 'web' rows need no Entra app registration (reachability probe + donated
    // session only) — tenant/client become '-' placeholders.
    const kind = ['bc', 'fno', 'web'].includes(String(body.kind)) ? body.kind : 'bc';
    const row = await (this.prisma as any).customer_environments.create({
      data: {
        customer_id: body.customer_id,
        project_id: body.project_id ?? null,
        kind,
        name: String(body.name).slice(0, 200),
        base_url: body.base_url?.trim() || null,
        tenant_id: String(body.tenant_id ?? (kind === 'web' ? '-' : '')).trim(),
        client_id: String(body.client_id ?? (kind === 'web' ? '-' : '')).trim(),
        secret_encrypted: body.client_secret ? encryptSecret(body.client_secret) : null,
      },
    });
    await this.audit.log({ actorType: 'user', action: 'create', entityType: 'customer_environments', entityId: row.id, summary: `Customer environment added: ${row.kind}/${row.name}` });
    return this.redact(row);
  }

  @Roles('admin')
  @Post(':id/secret')
  async setSecret(@Param('id') id: string, @Body() body: { client_secret: string }) {
    if (!body?.client_secret) return { ok: false, detail: 'client_secret gerekli' };
    await (this.prisma as any).customer_environments.update({
      where: { id },
      data: { secret_encrypted: encryptSecret(body.client_secret), status: 'new', last_error: null },
    });
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'customer_environments', entityId: id, summary: 'Environment secret rotated' });
    return { ok: true };
  }

  @Roles('admin')
  @Post(':id/probe')
  probe(@Param('id') id: string) {
    return this.svc.probe(id);
  }

  // Donated browser session (consent-once flow): the owner logs in with MFA
  // via scripts/env-login.mjs, which POSTs the Playwright storageState here.
  // Stored AES-256-GCM; slides forward on every successful screenshot.
  @Roles('admin')
  @Post(':id/session')
  async donateSession(@Param('id') id: string, @Body() body: { storageState: unknown }) {
    if (!body?.storageState || typeof body.storageState !== 'object') {
      return { ok: false, detail: 'storageState (Playwright JSON) gerekli' };
    }
    const cookies = (body.storageState as any).cookies?.length ?? 0;
    await (this.prisma as any).customer_environments.update({
      where: { id },
      data: { ui_session_encrypted: encryptSecret(JSON.stringify(body.storageState)), ui_session_saved_at: new Date() },
    });
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'customer_environments', entityId: id, summary: `Browser session donated for screenshots (${cookies} cookie)` });
    return { ok: true, cookies };
  }

  // UI service account for authenticated screenshots (write-only; password
  // AES-256-GCM). Dedicated MFA'sız read-only sandbox user önerilir.
  @Roles('admin')
  @Post(':id/ui-user')
  async setUiUser(@Param('id') id: string, @Body() body: { ui_user: string; ui_password: string }) {
    if (!body?.ui_user || !body?.ui_password) return { ok: false, detail: 'ui_user ve ui_password gerekli' };
    await (this.prisma as any).customer_environments.update({
      where: { id },
      data: { ui_user: String(body.ui_user).trim().slice(0, 200), ui_password_encrypted: encryptSecret(body.ui_password) },
    });
    await this.audit.log({ actorType: 'user', action: 'update', entityType: 'customer_environments', entityId: id, summary: 'UI screenshot service account set/rotated' });
    return { ok: true };
  }

  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await (this.prisma as any).customer_environments.delete({ where: { id } });
    await this.audit.log({ actorType: 'user', action: 'delete', entityType: 'customer_environments', entityId: id, summary: 'Customer environment removed' });
    return { ok: true };
  }
}

@Module({
  imports: [AuditModule],
  controllers: [EnvironmentsController],
  providers: [EnvironmentsService],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
