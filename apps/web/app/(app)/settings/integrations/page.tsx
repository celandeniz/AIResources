'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle, CHANNEL_ICON } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Plug, Wifi } from 'lucide-react';

const TYPE_LABEL: Record<string, string> = {
  graph_email: 'Outlook', graph_calendar: 'Calendar', graph_teams: 'Teams', ado_org: 'Azure DevOps',
  github: 'GitHub', opsconnect: 'OpsConnect', business_central: 'Business Central', sharepoint: 'SharePoint', crm: 'CRM',
};
const TYPE_ICON: Record<string, string> = { graph_email: 'email', graph_calendar: 'calendar', graph_teams: 'teams', ado_org: 'devops', github: 'github', opsconnect: 'opsconnect', business_central: 'business_central', sharepoint: 'sharepoint', crm: 'crm' };

export default function IntegrationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);

  async function load() { setItems(await api('/integrations')); setLoading(false); }
  useEffect(() => { load().catch(() => setLoading(false)); }, []);

  async function test(id: string) {
    setTesting(id);
    try { const r = await api(`/integrations/${id}/test`, { method: 'POST' }); r.ok ? toast.success('Connection OK', { description: r.detail }) : toast.error('Connection failed', { description: r.detail }); }
    catch (e: any) { toast.error(e.message); } finally { setTesting(null); }
  }

  const groups = items.reduce((acc: Record<string, any[]>, i) => { (acc[i.type] ??= []).push(i); return acc; }, {});

  return (
    <div>
      <PageHeader title="Connection Registry" subtitle="Every inbound/outbound connection — Outlook, Teams, DevOps, GitHub, OpsConnect, Business Central." />
      {loading ? <div className="grid gap-4 md:grid-cols-2">{[0,1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div> : (
        <div className="space-y-7">
          {Object.entries(groups).map(([type, rows]) => {
            const Icon = CHANNEL_ICON[TYPE_ICON[type]] ?? Plug;
            return (
              <div key={type}>
                <SectionTitle>{TYPE_LABEL[type] ?? type}</SectionTitle>
                <div className="grid gap-3 md:grid-cols-2">
                  {rows.map((i) => (
                    <Card key={i.id} className="flex items-center gap-3 p-4">
                      <div className="grid size-10 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><Icon className="size-5" /></div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{i.name}</span>
                          <Badge variant={i.is_mock ? 'neutral' : 'success'}>{i.is_mock ? 'mock' : 'live'}</Badge>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline">{i.direction}</Badge>
                          <span className={i.status === 'connected' ? 'text-success' : i.status === 'error' ? 'text-danger' : ''}>{i.status}</span>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => test(i.id)} disabled={testing === i.id}><Wifi className="size-4" />{testing === i.id ? '…' : 'Test'}</Button>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
