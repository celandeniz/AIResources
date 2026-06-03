'use client';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { api, apiStreamUrl } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState, ConfidenceDial } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input, Select } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Check, X, ShieldCheck, ExternalLink, CheckCheck, Sparkles, Save, RefreshCw, Search } from 'lucide-react';

interface Filters {
  aiResourceId: string;
  model: string;
  subject: string;
  aiAnswersOnly: boolean;
  hideSystem: boolean;
}

export default function ApprovalsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [opts, setOpts] = useState<{ resources: { id: string; name: string }[]; models: string[] }>({ resources: [], models: [] });
  const [filters, setFilters] = useState<Filters>({ aiResourceId: '', model: '', subject: '', aiAnswersOnly: false, hideSystem: true });

  // Per-card edit state: { [id]: { draft, instruction, mode } }
  const [edit, setEdit] = useState<Record<string, { draft: string; instruction: string }>>({});

  const qs = useMemo(() => {
    const p = new URLSearchParams({ status: 'pending' });
    if (filters.aiResourceId) p.set('aiResourceId', filters.aiResourceId);
    if (filters.model) p.set('model', filters.model);
    if (filters.subject.trim()) p.set('subject', filters.subject.trim());
    if (filters.aiAnswersOnly) p.set('aiAnswersOnly', 'true');
    p.set('hideSystem', filters.hideSystem ? 'true' : 'false');
    return p.toString();
  }, [filters]);

  const load = useCallback(async () => {
    const r = await api(`/approvals?${qs}`); setItems(r ?? []);
    setSelected((prev) => new Set([...prev].filter((id) => (r ?? []).some((x: any) => x.id === id))));
    setLoading(false);
  }, [qs]);
  useEffect(() => { setLoading(true); load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => { api('/approvals/filter-options').then(setOpts).catch(() => {}); }, []);
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

  function editState(ap: any) {
    return edit[ap.id] ?? { draft: ap.draft_text ?? '', instruction: '' };
  }
  function setEditField(id: string, field: 'draft' | 'instruction', value: string) {
    setEdit((prev) => ({ ...prev, [id]: { draft: prev[id]?.draft ?? '', instruction: prev[id]?.instruction ?? '', [field]: value } }));
  }

  async function saveDraft(ap: any) {
    const st = editState(ap);
    setBusy(ap.id);
    try {
      await api(`/approvals/${ap.id}/draft`, { method: 'POST', body: JSON.stringify({ content: st.draft }) });
      toast.success('Draft saved');
      load();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  async function regenerate(ap: any) {
    const st = editState(ap);
    if (!st.instruction.trim()) { toast.error('Add a short instruction first'); return; }
    setBusy(ap.id);
    try {
      const r = await api(`/approvals/${ap.id}/regenerate`, { method: 'POST', body: JSON.stringify({ instruction: st.instruction }) });
      const newText = r?.draft_text ?? '';
      setEdit((prev) => ({ ...prev, [ap.id]: { draft: newText, instruction: '' } }));
      setItems((xs) => xs.map((x) => (x.id === ap.id ? { ...x, draft_text: newText } : x)));
      toast.success('Answer regenerated');
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
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
    setItems((xs) => xs.filter((x) => !selected.has(x.id)));
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
  const activeFilters = filters.aiResourceId || filters.model || filters.subject || filters.aiAnswersOnly || !filters.hideSystem;

  return (
    <div>
      <PageHeader title="Approval Center" subtitle="Draft-first: AI actions wait here until a human approves." />

      {/* Filter bar */}
      <Card className="mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="w-56 pl-8" placeholder="Search subject…" value={filters.subject} onChange={(e) => setFilters((f) => ({ ...f, subject: e.target.value }))} />
          </div>
          <Select className="w-48" value={filters.aiResourceId} onChange={(e) => setFilters((f) => ({ ...f, aiResourceId: e.target.value }))}>
            <option value="">All AI resources</option>
            {opts.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
          <Select className="w-40" value={filters.model} onChange={(e) => setFilters((f) => ({ ...f, model: e.target.value }))}>
            <option value="">All models</option>
            {opts.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={filters.aiAnswersOnly} onChange={(e) => setFilters((f) => ({ ...f, aiAnswersOnly: e.target.checked }))} />
            AI answers only
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={filters.hideSystem} onChange={(e) => setFilters((f) => ({ ...f, hideSystem: e.target.checked }))} />
            Hide system-generated
          </label>
          {activeFilters && (
            <Button size="sm" variant="ghost" onClick={() => setFilters({ aiResourceId: '', model: '', subject: '', aiAnswersOnly: false, hideSystem: true })}>Clear</Button>
          )}
        </div>
      </Card>

      {loading ? (
        <div className="space-y-3">{[0,1].map(i => <Skeleton key={i} className="h-40" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="All clear" hint={activeFilters ? 'No approvals match these filters.' : 'No actions awaiting approval right now.'} />
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

          {items.map((ap) => {
            const st = editState(ap);
            const dirty = ap.is_ai_answer && st.draft !== (ap.draft_text ?? '');
            return (
              <Card key={ap.id} className={`overflow-hidden transition-shadow ${selected.has(ap.id) ? 'ring-2 ring-primary/40' : ''}`}>
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-5 py-3">
                  <input type="checkbox" className="size-4 accent-[hsl(var(--primary))]" checked={selected.has(ap.id)} onChange={() => toggle(ap.id)} aria-label="Select approval" />
                  <span className="font-mono text-sm font-semibold">{ap.action}</span>
                  <Badge variant={riskVariant(ap.risk_level)}>{ap.risk_level} risk</Badge>
                  {ap.agent_run?.ai_resource?.name && <Badge variant="neutral">{ap.agent_run.ai_resource.name}</Badge>}
                  {ap.agent_run?.llm_model && <Badge variant="outline">{ap.agent_run.llm_model}</Badge>}
                  {ap.system_generated && <Badge variant="warning">system</Badge>}
                  {ap.amount && <Badge variant="outline">${Number(ap.amount).toLocaleString()}</Badge>}
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => decide(ap.id, 'reject')} disabled={busy === ap.id}><X className="size-4" />Reject</Button>
                    <Button size="sm" variant="success" onClick={() => decide(ap.id, 'approve')} disabled={busy === ap.id}><Check className="size-4" />Approve & execute</Button>
                  </div>
                </div>
                <div className="grid gap-5 p-5 md:grid-cols-5">
                  <div className="md:col-span-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {ap.is_ai_answer ? 'AI answer (editable)' : 'Action preview'}
                      </div>
                      {ap.activity?.id && <Link href={`/inbox/${ap.activity.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">Open activity <ExternalLink className="size-3" /></Link>}
                    </div>

                    {ap.is_ai_answer ? (
                      <div className="space-y-2">
                        {Array.isArray(ap.payload?.alternatives) && ap.payload.alternatives.length > 0 && (
                          <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-2.5">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Alternatif yanıtlar — birini seç</div>
                            <div className="grid gap-1.5">
                              {ap.payload.alternatives.map((alt: any, idx: number) => {
                                const chosen = st.draft.trim() === String(alt.content).trim();
                                return (
                                  <button
                                    key={idx}
                                    type="button"
                                    onClick={() => setEditField(ap.id, 'draft', String(alt.content))}
                                    className={`flex items-start gap-2 rounded-md border p-2 text-left text-xs transition-colors ${chosen ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'}`}
                                  >
                                    <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${chosen ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'}`}>{chosen ? '✓' : ''}</span>
                                    <span className="min-w-0">
                                      <span className="font-medium text-foreground">{alt.label}</span>
                                      <span className="ml-2 text-muted-foreground">{String(alt.content).slice(0, 110)}{String(alt.content).length > 110 ? '…' : ''}</span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <textarea
                          aria-label="AI answer draft"
                          placeholder="AI answer…"
                          className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm leading-relaxed focus:border-primary focus:outline-none"
                          value={st.draft}
                          onChange={(e) => setEditField(ap.id, 'draft', e.target.value)}
                        />
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" disabled={!dirty || busy === ap.id} onClick={() => saveDraft(ap)}><Save className="size-4" />Save edit</Button>
                        </div>
                        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-2">
                          <Sparkles className="size-4 shrink-0 text-primary" />
                          <Input
                            className="flex-1"
                            placeholder="Short instruction to regenerate… (e.g. 'make it shorter and confirm Friday')"
                            value={st.instruction}
                            onChange={(e) => setEditField(ap.id, 'instruction', e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') regenerate(ap); }}
                          />
                          <Button size="sm" disabled={busy === ap.id || !st.instruction.trim()} onClick={() => regenerate(ap)}>
                            <RefreshCw className={`size-4 ${busy === ap.id ? 'animate-spin' : ''}`} />Regenerate
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">{JSON.stringify(ap.payload, null, 2)}</pre>
                    )}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
