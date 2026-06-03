'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle, CHANNEL_ICON } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Plug, Wifi, Database } from 'lucide-react';

const TYPE_LABEL: Record<string, string> = {
  graph_email: 'Outlook', graph_calendar: 'Calendar', graph_teams: 'Teams', ado_org: 'Azure DevOps',
  github: 'GitHub', opsconnect: 'OpsConnect', business_central: 'Business Central', sharepoint: 'SharePoint', crm: 'CRM',
  whatsapp: 'WhatsApp', cosmos: 'Azure Cosmos DB',
};
const TYPE_ICON: Record<string, string> = { graph_email: 'email', graph_calendar: 'calendar', graph_teams: 'teams', ado_org: 'devops', github: 'github', opsconnect: 'opsconnect', business_central: 'business_central', sharepoint: 'sharepoint', crm: 'crm' };

// Human-friendly labels for known config keys (fallback: prettified key).
const CONFIG_LABEL: Record<string, string> = {
  mailbox: 'Mailbox', base_url: 'Base URL', projects: 'Projects', org: 'Org', repo: 'Repo',
  tenant: 'Tenant', environment: 'Environment', company: 'Company', phone: 'Phone',
  account: 'Account', endpoint: 'Endpoint', database: 'Database', access: 'Access',
  containers: 'Containers', powers: 'Powers', join_key: 'Join Key', note: 'Note',
};

function prettyKey(k: string): string {
  return CONFIG_LABEL[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderValue(v: any): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function fmtDate(s?: string): string {
  if (!s) return '';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

export default function IntegrationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  async function load() { setItems(await api('/integrations')); setLoading(false); }
  useEffect(() => { load().catch(() => setLoading(false)); }, []);

  async function test(id: string) {
    setTesting(id);
    try {
      const r = await api(`/integrations/${id}/test`, { method: 'POST' });
      setResults((prev) => ({ ...prev, [id]: { ok: !!r.ok, detail: r.detail ?? '' } }));
      r.ok ? toast.success('Connection OK', { description: r.detail }) : toast.error('Connection failed', { description: r.detail });
    } catch (e: any) { toast.error(e.message); } finally { setTesting(null); }
  }

  const groups = items.reduce((acc: Record<string, any[]>, i) => { (acc[i.type] ??= []).push(i); return acc; }, {});

  return (
    <div>
      <PageHeader title="Connection Registry" subtitle="Every inbound/outbound connection — Outlook, Teams, DevOps, GitHub, OpsConnect, Business Central, Cosmos DB." />
      {loading ? <div className="grid gap-4 md:grid-cols-2">{[0,1,2,3].map(i => <Skeleton key={i} className="h-44" />)}</div> : (
        <div className="space-y-7">
          {Object.entries(groups).map(([type, rows]) => {
            const Icon = type === 'cosmos' ? Database : (CHANNEL_ICON[TYPE_ICON[type]] ?? Plug);
            return (
              <div key={type}>
                <SectionTitle>{TYPE_LABEL[type] ?? type}</SectionTitle>
                <div className="grid gap-3 md:grid-cols-2">
                  {rows.map((i) => {
                    const cfg = (i.config ?? {}) as Record<string, any>;
                    const cfgEntries = Object.entries(cfg).filter(([, v]) => v !== null && v !== undefined && v !== '');
                    const res = results[i.id];
                    return (
                      <Card key={i.id} className="flex flex-col gap-3 p-4">
                        {/* Header row */}
                        <div className="flex items-center gap-3">
                          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><Icon className="size-5" /></div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{i.name}</span>
                              <Badge variant={i.is_mock ? 'neutral' : 'success'}>{i.is_mock ? 'mock' : 'live'}</Badge>
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                              <Badge variant="outline">{i.direction}</Badge>
                              <span className={i.status === 'connected' ? 'text-success' : i.status === 'error' ? 'text-danger' : ''}>{i.status}</span>
                              {i.credentials_ref && <span className="font-mono text-[11px] opacity-70">{i.credentials_ref}</span>}
                            </div>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => test(i.id)} disabled={testing === i.id}><Wifi className="size-4" />{testing === i.id ? '…' : 'Test'}</Button>
                        </div>

                        {/* Config details */}
                        {cfgEntries.length > 0 && (
                          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
                            {cfgEntries.map(([k, v]) => (
                              <div key={k} className="contents">
                                <dt className="text-muted-foreground">{prettyKey(k)}</dt>
                                <dd className="min-w-0 break-words font-medium tabular-nums">{renderValue(v)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}

                        {/* Status footer */}
                        {(i.last_synced_at || i.last_error || res) && (
                          <div className="space-y-1 text-[11px]">
                            {i.last_synced_at && <div className="text-muted-foreground">Last synced: {fmtDate(i.last_synced_at)}</div>}
                            {i.last_error && <div className="text-danger">Error: {i.last_error}</div>}
                            {res && <div className={res.ok ? 'text-success' : 'text-danger'}>{res.ok ? '✓ ' : '✗ '}{res.detail}</div>}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
