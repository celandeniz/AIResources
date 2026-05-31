'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { relativeTime } from '../../../lib/utils';
import { Download, ScrollText } from 'lucide-react';

const ACTION_VARIANT: Record<string, any> = { approve: 'success', execute: 'success', reject: 'danger', escalate: 'warning', route: 'default', draft: 'default', ingest: 'neutral', index: 'neutral', create: 'neutral' };

export default function AuditPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api('/audit-logs').then((d) => { setLogs(d); setLoading(false); }).catch(() => setLoading(false)); }, []);

  function exportCsv() {
    const rows = [['time', 'actor', 'action', 'entity', 'summary'], ...logs.map((l) => [l.created_at, l.actor_type, l.action, l.entity_type, (l.summary ?? '').replace(/,/g, ';')])];
    const csv = rows.map((r) => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `audit-${Date.now()}.csv`; a.click();
  }

  return (
    <div>
      <PageHeader title="Audit & Logs" subtitle="Immutable trail — every route, draft, approval and execution." actions={<Button variant="outline" onClick={exportCsv} disabled={!logs.length}><Download className="size-4" />Export CSV</Button>} />
      {loading ? <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-12" />)}</div>
       : logs.length === 0 ? <EmptyState icon={ScrollText} title="No audit entries yet" />
       : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2.5 text-left font-medium">Time</th><th className="px-4 py-2.5 text-left font-medium">Actor</th><th className="px-4 py-2.5 text-left font-medium">Action</th><th className="px-4 py-2.5 text-left font-medium">Entity</th><th className="px-4 py-2.5 text-left font-medium">Summary</th></tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-border transition-colors hover:bg-muted/30">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">{relativeTime(l.created_at)}</td>
                  <td className="px-4 py-2.5"><Badge variant="neutral">{l.actor_type}</Badge></td>
                  <td className="px-4 py-2.5"><Badge variant={ACTION_VARIANT[l.action] ?? 'neutral'}>{l.action}</Badge></td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{l.entity_type}</td>
                  <td className="px-4 py-2.5 text-foreground/90">{l.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
