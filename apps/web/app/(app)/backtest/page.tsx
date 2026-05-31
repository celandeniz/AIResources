'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle, ConfidenceDial, EmptyState } from '../../../components/domain';
import { DonutChart } from '../../../components/charts';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { relativeTime } from '../../../lib/utils';
import { History, Lock, Play, ChevronRight, Clock, TrendingUp, Mail, Wrench, ShieldCheck } from 'lucide-react';

const DECISION: Record<string, { v: any; label: string }> = {
  auto: { v: 'success', label: 'Auto-execute' },
  approval: { v: 'warning', label: 'Needs approval' },
  escalate: { v: 'danger', label: 'Escalate' },
  none: { v: 'neutral', label: 'No match' },
};

export default function BacktestPage() {
  const [runs, setRuns] = useState<any[]>([]);
  const [current, setCurrent] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const poll = useRef<any>(null);

  const loadRuns = useCallback(async () => { setRuns(await api('/backtests')); }, []);
  useEffect(() => { loadRuns().catch(() => {}); }, [loadRuns]);

  const openRun = useCallback(async (id: string) => {
    const r = await api(`/backtests/${id}`);
    setCurrent(r);
    if (r.status === 'done' || r.status === 'failed') { clearInterval(poll.current); loadRuns(); }
  }, [loadRuns]);

  useEffect(() => () => clearInterval(poll.current), []);

  async function run() {
    setBusy(true);
    try {
      const { id, total } = await api('/backtests', { method: 'POST', body: JSON.stringify({ days: 30, cap: 200, sources: ['outlook', 'teams', 'devops'] }) });
      toast.success(`Simulating ${total} real items across sources…`);
      await openRun(id);
      poll.current = setInterval(() => openRun(id), 2500);
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  const s = current?.summary ?? {};
  const pct = current?.total ? Math.round((current.processed / current.total) * 100) : 0;

  return (
    <div>
      <PageHeader title="Backtest · Time Machine" subtitle="Replay real history through your AI workforce — see what it would have done." />

      <div className="mb-5 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/8 px-4 py-2.5 text-sm">
        <Lock className="size-4 text-primary" />
        <span><b>Simulation.</b> Reads your mailbox read-only — no emails are sent and nothing is changed.</span>
      </div>

      {/* Launch */}
      <Card className="mb-6 flex flex-wrap items-center gap-4 p-5">
        <div className="grid size-11 place-items-center rounded-xl bg-primary/12 text-primary"><History className="size-5" /></div>
        <div className="flex-1">
          <div className="font-medium">Run a backtest</div>
          <div className="text-sm text-muted-foreground">Sources: <b>Outlook</b> + <b>Teams</b> + <b>Azure DevOps</b> · last 30 days · up to <b>200</b> items · fast local model for large runs.</div>
        </div>
        <Button onClick={run} disabled={busy || (current && current.status === 'running')}><Play className="size-4" />{busy ? 'Starting…' : 'Run simulation'}</Button>
      </Card>

      {/* Progress / report */}
      {current && (
        <Card className="mb-6 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border bg-muted/25 px-5 py-3">
            <div className="font-medium">{current.label}</div>
            <Badge variant={current.status === 'done' ? 'success' : current.status === 'failed' ? 'danger' : 'warning'}>{current.status}</Badge>
          </div>
          {current.config?.notes?.length > 0 && (
            <div className="space-y-0.5 border-b border-border px-5 py-2.5 text-xs text-muted-foreground">
              {current.config.notes.map((n: string, i: number) => <div key={i}>· {n}</div>)}
            </div>
          )}

          {current.status !== 'done' && (
            <div className="p-5">
              <div className="mb-2 flex justify-between text-sm text-muted-foreground"><span>Processing {current.processed} / {current.total}</span><span>{pct}%</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
              <div className="mt-3 flex gap-2 text-xs text-muted-foreground"><Skeleton className="h-4 w-24" /> running real LLM calls…</div>
            </div>
          )}

          {current.status === 'done' && (
            <>
              <div className="relative grid gap-6 bg-foreground p-6 text-background sm:grid-cols-4">
                <div className="absolute inset-0 mesh opacity-40" />
                <Hero icon={Clock} label="Hours we'd have saved" value={`${s.hoursSaved ?? 0}h`} />
                <Hero icon={TrendingUp} label="Value" value={`$${(s.valueSaved ?? 0).toLocaleString()}`} accent />
                <Hero icon={ShieldCheck} label="Avg confidence" value={s.avgConfidence != null ? `${Math.round(s.avgConfidence * 100)}%` : '—'} />
                <Hero icon={Mail} label="Emails simulated" value={current.total} />
              </div>
              <div className="grid gap-5 p-5 lg:grid-cols-3">
                <div className="lg:col-span-1">
                  <SectionTitle>How we'd have handled them</SectionTitle>
                  <DonutChart data={[
                    { name: 'Auto-execute', value: s.autoCount ?? 0, color: 'hsl(var(--success))' },
                    { name: 'Needs approval', value: s.approvalCount ?? 0, color: 'hsl(var(--warning))' },
                    { name: 'Escalate', value: s.escalateCount ?? 0, color: 'hsl(var(--danger))' },
                  ]} />
                </div>
                <div className="lg:col-span-2">
                  <SectionTitle>Routed to</SectionTitle>
                  <div className="space-y-1.5">
                    {(s.byResource ?? []).map((r: any) => (
                      <div key={r.name} className="flex items-center gap-2 text-sm"><span className="flex-1">{r.name}</span><span className="font-mono tnum text-muted-foreground">{r.count}</span></div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </Card>
      )}

      {/* Per-item results */}
      {current?.items?.length > 0 && (
        <Card className="mb-6 divide-y divide-border overflow-hidden">
          {current.items.map((it: any) => {
            const open = expanded.has(it.id);
            const d = DECISION[it.decision] ?? DECISION.none;
            return (
              <div key={it.id}>
                <button type="button" onClick={() => setExpanded((s) => { const n = new Set(s); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
                  <ConfidenceDial value={it.confidence != null ? Number(it.confidence) : null} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="neutral">{it.source ?? 'outlook'}</Badge>
                      <span className="truncate text-sm font-medium">{it.subject || '(no subject)'}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{it.from_address} · {relativeTime(it.received_at)}{it.routed_resource_name ? ` · ${it.routed_resource_name}` : ''}</div>
                  </div>
                  <Badge variant={d.v}>{d.label}</Badge>
                  <ChevronRight className={`size-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
                </button>
                {open && (
                  <div className="grid gap-4 bg-muted/20 px-4 py-4 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Original</div>
                      <p className="text-sm text-muted-foreground line-clamp-4">{it.body || '—'}</p>
                      <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reasoning</div>
                      <p className="text-sm">{it.reasoning || '—'}</p>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Draft we'd have produced</div>
                      <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-card p-3 text-xs whitespace-pre-wrap">{it.draft?.content || '—'}</pre>
                      {(it.tool_intents ?? []).length > 0 && (
                        <>
                          <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Would have done</div>
                          <div className="space-y-1">
                            {it.tool_intents.map((t: any, i: number) => (
                              <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"><Wrench className="size-3 text-muted-foreground" /><span className="font-mono">{t.tool}</span>{t.sensitive && <Badge variant="warning">approval</Badge>}</div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {/* History */}
      <SectionTitle>Past backtests</SectionTitle>
      {!runs.length ? <EmptyState icon={History} title="No backtests yet" hint="Run a simulation to replay your last 30 days." />
       : (
        <Card className="divide-y divide-border">
          {runs.map((r) => (
            <button type="button" key={r.id} onClick={() => openRun(r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40">
              <History className="size-4 text-muted-foreground" />
              <div className="flex-1"><div className="text-sm font-medium">{r.label}</div><div className="text-xs text-muted-foreground">{relativeTime(r.created_at)} · {r.total} emails</div></div>
              {r.summary?.valueSaved != null && <span className="text-sm font-medium text-success">${r.summary.valueSaved.toLocaleString()}</span>}
              <Badge variant={r.status === 'done' ? 'success' : r.status === 'running' ? 'warning' : 'neutral'}>{r.status}</Badge>
            </button>
          ))}
        </Card>
      )}
    </div>
  );
}

function Hero({ icon: Icon, label, value, accent }: { icon: any; label: string; value: React.ReactNode; accent?: boolean }) {
  return (
    <div className="relative">
      <div className="mb-2 inline-flex size-8 items-center justify-center rounded-lg bg-background/10"><Icon className="size-4 text-background/80" /></div>
      <div className="font-display text-3xl tracking-tight tnum" style={accent ? { color: 'hsl(var(--brand-h) var(--brand-s) 72%)' } : undefined}>{value}</div>
      <div className="mt-0.5 text-xs text-background/60">{label}</div>
    </div>
  );
}
