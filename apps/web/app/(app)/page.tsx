'use client';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { PageHeader, SectionTitle } from '../../components/domain';
import { KpiCard, DonutChart } from '../../components/charts';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import Link from 'next/link';
import { Clock, CheckCircle2, AlertTriangle, Gauge, TrendingUp, Cpu, History, ChevronRight } from 'lucide-react';

export default function DashboardPage() {
  const [s, setS] = useState<any>(null);
  const [perf, setPerf] = useState<any[]>([]);
  const [aih, setAih] = useState<any>(null);
  const [roi, setRoi] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [bt, setBt] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api('/dashboard/summary').then(setS).catch(() => {}),
      api('/dashboard/agent-performance').then(setPerf).catch(() => {}),
      api('/dashboard/ai-vs-human').then(setAih).catch(() => {}),
      api('/dashboard/roi').then(setRoi).catch(() => {}),
      api('/dashboard/usage').then(setUsage).catch(() => {}),
      api('/backtests').then((r: any[]) => setBt(r?.find((x) => x.status === 'done') ?? r?.[0] ?? null)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader title="Command center" subtitle="What your AI workforce delivered — and what it's worth." />

      {/* ROI hero band */}
      <Card className="relative mb-6 overflow-hidden border-0 bg-foreground text-background">
        <div className="absolute inset-0 mesh opacity-50" />
        <div className="absolute -right-16 -top-16 size-64 rounded-full bg-primary/30 blur-3xl" />
        <div className="relative grid gap-6 p-6 sm:grid-cols-4">
          <Hero label="Hours saved" value={roi ? `${roi.hoursSaved}h` : '—'} icon={Clock} />
          <Hero label="Value delivered" value={roi ? `$${roi.valueSaved?.toLocaleString()}` : '—'} icon={TrendingUp} accent />
          <Hero label="Automation rate" value={roi ? `${roi.automationRate}%` : '—'} icon={CheckCircle2} />
          <Hero label="SLA attainment" value={roi ? `${roi.slaPct}%` : '—'} icon={Gauge} sub={roi?.avgFirstResponseSec != null ? `${roi.avgFirstResponseSec}s avg response` : undefined} />
        </div>
      </Card>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0,1,2,3].map(i => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Activities handled" value={s?.activitiesHandled ?? 0} accent="primary" spark={[3,5,4,7,8,11,s?.activitiesHandled ?? 12]} sub="resolved by AI" />
          <KpiCard label="Pending approvals" value={s?.pendingApprovals ?? 0} accent="warning" sub="awaiting a human" />
          <KpiCard label="Avg confidence" value={s?.avgConfidence != null ? `${Math.round(s.avgConfidence*100)}` : '—'} accent="success" sub="across agent runs" />
          <KpiCard label="Est. spend" value={usage ? `$${usage.totalCost}` : '—'} accent="primary" sub={usage ? `${usage.localShare}% on free local models` : 'LLM cost'} />
        </div>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2 p-5">
          <SectionTitle right={usage ? <span className="text-xs text-muted-foreground">{usage.totalTokens?.toLocaleString()} tokens</span> : null}>AI Resource performance & cost</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="px-4 py-2.5 text-left font-medium">Resource</th><th className="px-4 py-2.5 text-left font-medium">Model</th><th className="px-4 py-2.5 text-right font-medium">Handled</th><th className="px-4 py-2.5 text-right font-medium">Avg conf.</th><th className="px-4 py-2.5 text-right font-medium">Cost</th></tr>
              </thead>
              <tbody>
                {perf.map((p) => {
                  const u = usage?.byResource?.find((x: any) => x.name === p.name);
                  return (
                    <tr key={p.aiResourceId} className="border-t border-border transition-colors hover:bg-muted/30">
                      <td className="px-4 py-2.5 font-medium">{p.name}</td>
                      <td className="px-4 py-2.5">{u ? <Badge variant={u.local ? 'success' : 'default'}><Cpu className="size-3" />{u.model}</Badge> : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono tnum">{p.handled}</td>
                      <td className="px-4 py-2.5 text-right font-mono tnum">{p.avgConfidence != null ? p.avgConfidence.toFixed(2) : '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono tnum text-muted-foreground">{u ? (u.local ? 'free' : `$${u.cost}`) : '—'}</td>
                    </tr>
                  );
                })}
                {!perf.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">No runs yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>AI vs human</SectionTitle>
          <DonutChart data={[
            { name: 'Auto-executed', value: aih?.autoExecuted ?? 0, color: 'hsl(var(--primary))' },
            { name: 'Human-approved', value: aih?.humanApproved ?? 0, color: 'hsl(var(--success))' },
            { name: 'Escalated', value: aih?.escalated ?? 0, color: 'hsl(var(--danger))' },
          ]} />
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4">
            <Stat icon={Clock} label="Avg response" value={s?.avgResponseMs != null ? `${s.avgResponseMs}ms` : '—'} />
            <Stat icon={CheckCircle2} label="Agent runs" value={s?.agentRuns ?? 0} />
            <Stat icon={AlertTriangle} label="Escalations" value={s?.escalations ?? 0} />
            <Stat icon={Gauge} label="Overdue" value={s?.overdueTasks ?? 0} />
          </div>
        </Card>
      </div>

      {/* Latest backtest (simulation over real history) */}
      {bt?.summary?.byResource && (
        <Card className="mt-6 p-5">
          <SectionTitle right={<Link href="/backtest" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Open backtest <ChevronRight className="size-3" /></Link>}>
            Latest backtest — how the AI would have handled real history
          </SectionTitle>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/20 p-4">
              <div className="grid size-10 place-items-center rounded-lg bg-primary/12 text-primary"><History className="size-5" /></div>
              <div>
                <div className="font-display text-2xl tnum">${(bt.summary.valueSaved ?? 0).toLocaleString()}</div>
                <div className="text-xs text-muted-foreground">{bt.summary.hoursSaved ?? 0}h saved · {bt.total} items</div>
              </div>
            </div>
            <div className="lg:col-span-2">
              <div className="mb-2 flex flex-wrap gap-2 text-xs">
                <Badge variant="success">{bt.summary.autoCount ?? 0} auto</Badge>
                <Badge variant="warning">{bt.summary.approvalCount ?? 0} need approval</Badge>
                <Badge variant="danger">{bt.summary.escalateCount ?? 0} escalate</Badge>
                <Badge variant="neutral">avg conf {bt.summary.avgConfidence != null ? Math.round(bt.summary.avgConfidence * 100) : '—'}%</Badge>
              </div>
              <div className="space-y-1">
                {bt.summary.byResource.slice(0, 5).map((r: any) => (
                  <div key={r.name} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate">{r.name}</span>
                    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((r.count / bt.total) * 100)}%` }} /></div>
                    <span className="w-8 text-right font-mono tnum text-muted-foreground">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Hero({ label, value, icon: Icon, sub, accent }: { label: string; value: React.ReactNode; icon: any; sub?: string; accent?: boolean }) {
  return (
    <div>
      <div className="mb-2 inline-flex size-8 items-center justify-center rounded-lg bg-background/10"><Icon className="size-4 text-background/80" /></div>
      <div className={`font-display text-3xl tracking-tight tnum ${accent ? 'text-primary-foreground' : ''}`} style={accent ? { color: 'hsl(var(--brand-h) var(--brand-s) 72%)' } : undefined}>{value}</div>
      <div className="mt-0.5 text-xs text-background/60">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-background/40">{sub}</div>}
    </div>
  );
}
function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-lg bg-muted/60 text-muted-foreground"><Icon className="size-4" /></div>
      <div><div className="font-mono text-sm font-semibold tnum">{value}</div><div className="text-[11px] text-muted-foreground">{label}</div></div>
    </div>
  );
}
