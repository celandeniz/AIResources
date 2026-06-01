'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { PageHeader, SectionTitle, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { Gauge } from 'lucide-react';

function InlineBar({ value, max = 1, color = 'bg-primary' }: { value: number | null; max?: number; color?: string }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-xs">{(value * 100).toFixed(0)}%</span>
    </div>
  );
}

export default function PerformancePage() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('/performance')
      .then((d: any) => { setRows(d ?? []); setLoading(false); })
      .catch((e: any) => { setErr(e.message); setLoading(false); });
  }, []);

  return (
    <div>
      <PageHeader
        title="Performance Scorecards"
        subtitle="Per-resource metrics: runs, confidence, acceptance rate, hours saved."
        actions={<Badge variant="neutral"><Gauge className="size-3" />Insights</Badge>}
      />

      {err && <Card className="p-6 text-danger">{err}</Card>}

      {loading && (
        <div className="space-y-3 mt-6">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      )}

      {!loading && !err && rows.length === 0 && (
        <EmptyState icon={Gauge} title="No data yet" description="Run some activities and they'll appear here." />
      )}

      {!loading && !err && rows.length > 0 && (
        <Card className="mt-6 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Resource</th>
                <th className="px-4 py-3 text-right">Runs</th>
                <th className="px-4 py-3 text-right">Handled</th>
                <th className="px-4 py-3 text-right">Escalated</th>
                <th className="px-4 py-3 text-right">Awaiting</th>
                <th className="px-4 py-3">Avg Confidence</th>
                <th className="px-4 py-3">Acceptance Rate</th>
                <th className="px-4 py-3 text-right">Hrs Saved</th>
                <th className="px-4 py-3 text-right">Feedback</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r: any) => (
                <tr key={r.aiResourceId} className="transition-colors hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate max-w-[200px]">{r.role}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.runs}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{r.activitiesHandled}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.escalated > 0
                      ? <span className="text-warning font-medium">{r.escalated}</span>
                      : <span className="text-muted-foreground">{r.escalated}</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.awaitingApproval > 0
                      ? <span className="text-warning">{r.awaitingApproval}</span>
                      : <span className="text-muted-foreground">{r.awaitingApproval}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <InlineBar value={r.avgConfidence} color="bg-primary" />
                  </td>
                  <td className="px-4 py-3">
                    <InlineBar value={r.acceptanceRate} color="bg-success" />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{r.hoursSaved}h</td>
                  <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                    {r.thumbsUp > 0 || r.thumbsDown > 0
                      ? <span>👍 {r.thumbsUp} / 👎 {r.thumbsDown}</span>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
