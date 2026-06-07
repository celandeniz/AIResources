'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { CalendarClock, Check, X, Clock, MapPin, Users, User, ExternalLink } from 'lucide-react';

function fmt(v: any): string {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString('tr-TR');
}
function attendeesLabel(att: any): string {
  if (Array.isArray(att)) return att.filter(Boolean).join(', ') || '—';
  return att ? String(att) : '—';
}

export default function MeetingsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [propose, setPropose] = useState<Record<string, { newTime: string; note: string }>>({});

  const load = useCallback(async () => {
    const r = await api('/meetings');
    setItems(r ?? []);
    setLoading(false);
  }, []);
  useEffect(() => { setLoading(true); load().catch(() => setLoading(false)); }, [load]);

  function pState(id: string) {
    return propose[id] ?? { newTime: '', note: '' };
  }
  function setP(id: string, field: 'newTime' | 'note', value: string) {
    setPropose((prev) => ({ ...prev, [id]: { ...pState(id), [field]: value } }));
  }

  async function accept(id: string) {
    setBusy(id);
    setItems((xs) => xs.filter((x) => x.id !== id)); // optimistic
    try {
      await api(`/meetings/${id}/accept`, { method: 'POST' });
      toast.success('Toplantı kabul edildi');
    } catch (e: any) { toast.error(e.message); load(); } finally { setBusy(null); }
  }

  async function reject(id: string) {
    setBusy(id);
    setItems((xs) => xs.filter((x) => x.id !== id)); // optimistic
    try {
      await api(`/meetings/${id}/reject`, { method: 'POST', body: JSON.stringify({ note: pState(id).note || 'Reddedildi' }) });
      toast.success('Toplantı reddedildi');
    } catch (e: any) { toast.error(e.message); load(); } finally { setBusy(null); }
  }

  async function proposeTime(id: string) {
    const st = pState(id);
    if (!st.newTime.trim()) { toast.error('Önce yeni bir zaman seç'); return; }
    setBusy(id);
    try {
      const r = await api(`/meetings/${id}/propose-time`, { method: 'POST', body: JSON.stringify({ newTime: st.newTime, note: st.note }) });
      const newText = r?.draft_text ?? '';
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, draft_text: newText } : x)));
      toast.success('Alternatif zaman önerisi taslağı hazırlandı');
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  return (
    <div>
      <PageHeader title="Toplantı Talepleri" subtitle="Takvim davetleri ve toplantı talepleri — kabul et, reddet veya alternatif zaman öner." />

      {loading ? (
        <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Bekleyen toplantı yok" hint="Onay bekleyen takvim talebi bulunmuyor." />
      ) : (
        <div className="space-y-4">
          {items.map((ap) => {
            const m = ap.meeting ?? {};
            const st = pState(ap.id);
            return (
              <Card key={ap.id} className="overflow-hidden">
                <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/25 px-5 py-3">
                  <CalendarClock className="size-4 text-muted-foreground" />
                  <span className="font-semibold">{m.title ?? ap.activity?.subject ?? 'Toplantı'}</span>
                  <Badge variant="neutral">{ap.action}</Badge>
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy === ap.id} onClick={() => reject(ap.id)}><X className="size-4" />Reddet</Button>
                    <Button size="sm" variant="success" disabled={busy === ap.id} onClick={() => accept(ap.id)}><Check className="size-4" />Kabul</Button>
                  </div>
                </div>

                {/* Origin */}
                {ap.origin && (
                  <div className="border-b border-border bg-background px-5 py-3">
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
                      {ap.origin.from && (
                        <span className="inline-flex items-center gap-1.5">
                          <User className="size-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">Gönderen:</span>
                          <span className="font-medium">{ap.origin.from}</span>
                        </span>
                      )}
                      {ap.origin.subject && (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-muted-foreground">Konu:</span>
                          <span className="font-medium">{ap.origin.subject}</span>
                        </span>
                      )}
                      {ap.activity?.id && (
                        <Link href={`/inbox/${ap.activity.id}`} className="ml-auto inline-flex items-center gap-1 text-primary hover:underline">
                          Aktiviteyi aç <ExternalLink className="size-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid gap-5 p-5 md:grid-cols-2">
                  {/* Meeting details */}
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Başlangıç:</span><span className="font-medium">{fmt(m.start)}</span></div>
                    <div className="flex items-center gap-2"><Clock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Bitiş:</span><span className="font-medium">{fmt(m.end)}</span></div>
                    <div className="flex items-start gap-2"><Users className="mt-0.5 size-4 text-muted-foreground" /><span className="text-muted-foreground">Katılımcılar:</span><span className="font-medium">{attendeesLabel(m.attendees)}</span></div>
                    {m.location && <div className="flex items-center gap-2"><MapPin className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Konum:</span><span className="font-medium">{m.location}</span></div>}
                  </div>

                  {/* Drafted reply */}
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Taslak yanıt</div>
                    <div className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed">
                      {ap.draft_text || '(taslak yok)'}
                    </div>
                  </div>
                </div>

                {/* Propose alternative time */}
                <div className="flex flex-wrap items-end gap-2 border-t border-border bg-muted/15 px-5 py-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-muted-foreground">Alternatif zaman</label>
                    <Input
                      type="datetime-local"
                      className="w-56"
                      value={st.newTime}
                      onChange={(e) => setP(ap.id, 'newTime', e.target.value)}
                    />
                  </div>
                  <Input
                    className="flex-1 min-w-48"
                    placeholder="Not (opsiyonel)…"
                    value={st.note}
                    onChange={(e) => setP(ap.id, 'note', e.target.value)}
                  />
                  <Button size="sm" variant="outline" disabled={busy === ap.id || !st.newTime.trim()} onClick={() => proposeTime(ap.id)}>
                    <CalendarClock className="size-4" />Alternatif zaman öner
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
