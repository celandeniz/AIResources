// Business Central (Dynamics 365) live adapter implementing ConnectorAdapter.
// BC API v2.0, OAuth2 client-credentials. Activates only when BC_* env is set
// (else executor falls back to mock). Never throws out of execute()/healthCheck.

import { Logger } from '@nestjs/common';
import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';
import type { IntegrationKind, ToolName } from '@dynops/shared';

const logger = new Logger('BusinessCentralAdapter');

export function bcConfigured(): boolean {
  return Boolean(
    process.env.BC_CLIENT_ID &&
      process.env.BC_CLIENT_SECRET &&
      process.env.BC_TENANT_ID &&
      process.env.BC_ENVIRONMENT,
  );
}

// ── OAuth client-credentials token (in-process cache, refresh 60s before expiry) ──
interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
let cached: CachedToken | null = null;

async function getBcToken(): Promise<string> {
  if (!bcConfigured()) throw new Error('BC not configured (set BC_TENANT_ID/CLIENT_ID/CLIENT_SECRET/ENVIRONMENT)');
  const now = Date.now();
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const tenant = process.env.BC_TENANT_ID!;
  const body = new URLSearchParams({
    client_id: process.env.BC_CLIENT_ID!,
    client_secret: process.env.BC_CLIENT_SECRET!,
    scope: 'https://api.businesscentral.dynamics.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`BC token ${res.status}: ${text}`);
  }
  const data: any = await res.json();
  cached = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3500) * 1000 };
  logger.log('Acquired Business Central app-only token');
  return cached.token;
}

const base = () =>
  `https://api.businesscentral.dynamics.com/v2.0/${process.env.BC_TENANT_ID}/${process.env.BC_ENVIRONMENT}/api/v2.0`;

// Accepts a path ("/companies...") or a full URL. Throws on !res.ok; returns
// parsed JSON (null for 204/empty body).
async function bcFetch(path: string, init: RequestInit = {}): Promise<any> {
  const token = await getBcToken();
  const url = path.startsWith('http') ? path : `${base()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BC ${res.status} ${path} — ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ── Company name → id resolution (cached) ───────────────────────────────────────
const companyCache = new Map<string, string>();

async function resolveCompanyId(name: string): Promise<string | null> {
  if (!name) return null;
  const cachedId = companyCache.get(name);
  if (cachedId) return cachedId;
  const esc = name.replace(/'/g, "''");
  let data = await bcFetch(`/companies?$filter=name eq '${esc}'`);
  if (!data?.value?.length) {
    data = await bcFetch(`/companies?$filter=displayName eq '${esc}'`);
  }
  const id = data?.value?.[0]?.id ?? null;
  if (id) companyCache.set(name, id);
  return id;
}

// ── Customer resolution by number (code) or displayName ─────────────────────────
async function resolveCustomer(
  cid: string,
  args: Record<string, unknown>,
): Promise<{ id: string; number: string; displayName: string } | null> {
  const code = (args.bcCustomer ?? args.customerNumber) as string | undefined;
  let data: any = null;
  if (code) {
    const esc = String(code).replace(/'/g, "''");
    data = await bcFetch(`/companies(${cid})/customers?$filter=number eq '${esc}'&$top=1`);
  } else {
    const name = String(args.customer ?? args.bcCustomer ?? '');
    if (!name) return null;
    const esc = name.replace(/'/g, "''");
    data = await bcFetch(`/companies(${cid})/customers?$filter=displayName eq '${esc}'&$top=1`);
  }
  const c = data?.value?.[0];
  if (!c) return null;
  return { id: c.id, number: c.number, displayName: c.displayName };
}

// ── Add lines to a sales order / invoice. Returns a human-readable note. ─────────
async function addLines(
  cid: string,
  entity: 'salesOrders' | 'salesInvoices',
  parentId: string,
  lines: any,
  config: Record<string, unknown>,
): Promise<string> {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const lineNo = config.default_line_no as string | number | undefined;
  const lineType = (config.default_line_type as string | undefined) ?? (lineNo ? 'Item' : 'Comment');
  const childCollection = entity === 'salesOrders' ? 'salesOrderLines' : 'salesInvoiceLines';
  const childPath = `/companies(${cid})/${entity}(${parentId})/${childCollection}`;
  const priced = lineType !== 'Comment' && Boolean(lineNo);

  let succeeded = 0;
  for (const line of lines) {
    try {
      const body = priced
        ? {
            lineType,
            lineObjectNumber: String(lineNo),
            quantity: Number(line.quantity ?? 1),
            unitPrice: Number(line.unitPrice ?? 0),
            description: String(line.description ?? ''),
          }
        : { lineType: 'Comment', description: String(line.description ?? '').slice(0, 250) };
      await bcFetch(childPath, { method: 'POST', body: JSON.stringify(body) });
      succeeded++;
    } catch {
      /* skip line on error; collect succeeded count */
    }
  }

  if (priced) return succeeded ? ` (${succeeded} line(s))` : '';
  return succeeded
    ? ` (${succeeded} comment line(s) added — no priced lines: set this BC connection's config.default_line_type + default_line_no to an Item/Resource/Account to post amounts)`
    : '';
}

export class BusinessCentralAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'business_central';

  async healthCheck(conn: ConnectionInfo): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    if (!bcConfigured()) {
      return { ok: false, latencyMs: 0, detail: 'BC_CLIENT_ID/SECRET/TENANT/ENVIRONMENT not set' };
    }
    const company = String(conn.config.company ?? '');
    const start = Date.now();
    try {
      const cid = await resolveCompanyId(company);
      await bcFetch(`/companies`);
      return {
        ok: true,
        latencyMs: Date.now() - start,
        detail: `BC OK — ${company} (${cid ? 'company found' : 'company NOT found'})`,
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - start, detail: (e as Error).message };
    }
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    try {
      const companyName = String(args.company ?? conn.config.company ?? '');
      const cid = await resolveCompanyId(companyName);
      if (!cid) return { ok: false, detail: `BC company "${companyName}" not found` };

      // ── READ-ONLY ──────────────────────────────────────────────────────────
      if (tool === 'bc_read_customer') {
        const c = await resolveCustomer(cid, args);
        if (!c) return { ok: false, detail: 'customer not found' };
        const customer = await bcFetch(`/companies(${cid})/customers(${c.id})`);
        return {
          ok: true,
          external_id: c.number,
          detail: `Customer ${c.displayName} (${c.number})`,
          data: customer,
        };
      }

      if (tool === 'bc_read_invoices') {
        const top = Number(args.top ?? 10);
        let path = `/companies(${cid})/salesInvoices?$top=${top}`;
        const code = (args.bcCustomer ?? args.customerNumber) as string | undefined;
        if (code) {
          path += `&$filter=customerNumber eq '${String(code).replace(/'/g, "''")}'`;
        }
        const data = await bcFetch(path);
        const value = data?.value ?? [];
        return { ok: true, detail: `${value.length} invoice(s)`, data: { invoices: value } };
      }

      if (tool === 'bc_read_balance') {
        const c = await resolveCustomer(cid, args);
        if (!c) return { ok: false, detail: 'customer not found' };
        const cust = await bcFetch(
          `/companies(${cid})/customers(${c.id})?$select=number,displayName,balanceDue,totalSalesExcludingTax`,
        );
        return {
          ok: true,
          external_id: c.number,
          detail: `Balance for ${c.displayName}: ${cust?.balanceDue}`,
          data: cust,
        };
      }

      // ── WRITE ──────────────────────────────────────────────────────────────
      if (tool === 'bc_create_invoice') {
        const c = await resolveCustomer(cid, args);
        if (!c) {
          return {
            ok: false,
            detail: 'bc_create_invoice: customer not resolvable (provide bcCustomer code or exact customer displayName)',
          };
        }
        const inv = await bcFetch(`/companies(${cid})/salesInvoices`, {
          method: 'POST',
          body: JSON.stringify({ customerNumber: c.number }),
        });
        const lineNote = await addLines(cid, 'salesInvoices', inv.id, args.lines, conn.config);
        return {
          ok: true,
          external_id: String(inv.number ?? inv.id),
          detail: `Created BC invoice ${inv.number} for ${c.displayName}` + lineNote,
          data: { id: inv.id, number: inv.number },
        };
      }

      if (tool === 'bc_create_sales_order') {
        const c = await resolveCustomer(cid, args);
        if (!c) {
          return {
            ok: false,
            detail: 'bc_create_sales_order: customer not resolvable (provide bcCustomer code or exact customer displayName)',
          };
        }
        const order = await bcFetch(`/companies(${cid})/salesOrders`, {
          method: 'POST',
          body: JSON.stringify({ customerNumber: c.number }),
        });
        const lineNote = await addLines(cid, 'salesOrders', order.id, args.lines, conn.config);
        return {
          ok: true,
          external_id: String(order.number ?? order.id),
          detail: `Created BC sales order ${order.number}` + lineNote,
          data: { id: order.id, number: order.number },
        };
      }

      if (tool === 'bc_post_payment') {
        return {
          ok: false,
          detail: 'bc_post_payment is not supported by the live BC adapter yet (requires customer payment journals / beta API)',
        };
      }

      return { ok: false, detail: `BusinessCentralAdapter cannot execute ${tool}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

export const businessCentralAdapter = new BusinessCentralAdapter();
