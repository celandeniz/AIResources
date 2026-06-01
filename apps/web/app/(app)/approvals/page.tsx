'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, apiStreamUrl } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState, ConfidenceDial } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { Check, X, ShieldCheck, ExternalLink, CheckCheck } from 'lucide-react';

export default function ApprovalsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api('/approvals?status=pending'); setItems(r ?? []);
    // Drop any selections that are no longer pending.
    setSelected((prev) => new Set([...prev].filter((id) => (r ?? []).some((x: any) => x.id === id))));
    setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => {
    let fallback: ReturnType<typeof setInterval> | undefined;
    try {
      const es = new EventSource(apiStreamUrl('/stream'));
      es.addEventListener('approval', () => load().catch(() => {}));
      es.addEventListener('notification', () => load().catch(() => {}));
      es.onerror = () => { es.close(); fallback = setInterval(() => load().catch(() => {}), 8000); };
      return () => { es.close(); if (fallback) clearInterval(fallback); };
    } catch {
      fallback = setInterval(() => load().catch(() => {}), 8000);
      return () => { if (fallback) clearInterval(fallback); };
    }
  }, [load]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusy(id);
    setItems((xs) => xs.filter((x) => x.id !== id)); // optimistic
    try {
      await api(`/approvals/${id}/${action}`, { method: 'POST', body: JSON.stringify({ note: `${action} via UI` }) });
      toast.success(action === 'approve' ? 'Approved & executed' : 'Rejected');
    } catch (e: any) { toast.error(e.message); load(); } finally { setBusy(null); }
  }

  function toggle(id: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((x) => x.id))));
  }

  async function bulkDecide(action: 'approve' | 'reject') {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    setItems((xs) => xs.filter((x) => !selected.has(x.id))); // optimistic
    setSelected(new Set());
    try {
      const r = await api('/approvals/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) });
      const failed = r?.failed?.length ?? 0;
      if (failed) toast.error(`${r.succeeded} ${action}d · ${failed} failed`);
      else toast.success(`${r.succeeded} ${action === 'approve' ? 'approved & executed' : 'rejected'}`);
    } catch (e: any) { toast.error(e.message); } finally { setBulkBusy(false); load(); }
  }

  const riskVariant = (r: string) => (r === 'critical' || r === 'high' ? 'danger' : 'warning');
  const allSelected = items.length > 0 && selected.size === items.length;

  return (
    <div>
      <PageHeader title="Approval Center" subtitle="Draft-first: AI actions wait here until a human approves." />
      {loading ? (
        <div className="space-y-3">{[0,1].map(i => <Skeleton key={i} className="h-40" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="All clear" hint="No actions awaiting approval right now." />
      ) : (
        <div className="space-y-4">
          {/* Bulk select bar */}
          <div className="sticky top-14 z-10 flex items-center gap-3 rounded-xl border border-border bg-card/90 px-4 py-2.5 backdrop-blur-md">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={allSelected} onChange={toggleAll} />
              <span className="text-muted-foreground">{selected.size > 0 ? `${selected.size} selected` : 'Select all'}</span>
            </label>
            {selected.size > 0 && (
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" disabled={bulkBusy} onClick={() => bulkDecide('reject')}><X className="size-4" />Reject selected</Button>
                <Button size="sm" variant="success" disabled={bulkBusy} onClick={() => bulkDecide('approve')}><CheckCheck className="size-4" />{bulkBusy ? 'Working…' : `Approve ${selected.size} selected`}</Button>
              </div>
            )}
          </div>
          {items.map((ap) => (
            <Card key={ap.id} className={`overflow-hidden transition-shadow ${selected.has(ap.id) ? 'ring-2 ring-primary/40' : ''}`}>
              <div className="flex items-center gap-3 border-b border-border bg-muted/25 px-5 py-3">
                <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={selected.has(ap.id)} onChange={() => toggle(ap.id)} aria-label="Select approval" />
                <span className="font-mono text-sm font-semibold">{ap.action}</span>
                <Badge variant={riskVariant(ap.risk_level)}>{ap.risk_level} risk</Badge>
                <Badge variant="neutral">{ap.reason}</Badge>
                {ap.amount && <Badge variant="outline">${Number(ap.amount).toLocaleString()}</Badge>}
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => decide(ap.id, 'reject')} disabled={busy === ap.id}><X className="size-4" />Reject</Button>
                  <Button size="sm" variant="success" onClick={() => decide(ap.id, 'approve')} disabled={busy === ap.id}><Check className="size-4" />Approve & execute</Button>
                </div>
              </div>
              <div className="grid gap-5 p-5 md:grid-cols-5">
                <div className="md:col-span-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Action preview</div>
                    {ap.activity?.id && <Link href={`/inbox/${ap.activity.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Open activity <ExternalLink className="size-3" /></Link>}
                  </div>
                  <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">{JSON.stringify(ap.payload, null, 2)}</pre>
                </div>
                <div className="md:col-span-2">
                  <div className="flex items-start gap-3">
                    <ConfidenceDial value={ap.agent_run?.confidence_score != null ? Number(ap.agent_run.confidence_score) : null} size={64} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{ap.activity?.subject}</div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{ap.agent_run?.reasoning_summary}</p>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
