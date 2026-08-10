'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, EmptyState } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Brain, RotateCcw, Archive } from 'lucide-react';

export default function InstinctsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setItems(await api('/instincts')); setLoading(false); }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function act(id: string, action: 'retire' | 'restore') {
    try { await api(`/instincts/${id}/${action}`, { method: 'POST' }); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  const active = items.filter((i) => i.status === 'active');
  const retired = items.filter((i) => i.status !== 'active');

  return (
    <div>
      <PageHeader title="Instincts" subtitle="Onay geri bildirimlerinden damıtılan, güven skorlu dersler — yüksek güvenli olanlar prompt'lara otomatik enjekte edilir." />
      {loading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : !items.length ? (
        <EmptyState icon={Brain} title="Henüz instinct yok" hint="Taslakları düzenleyip/reddettikçe sistem dersler çıkarmaya başlar." />
      ) : (
        <div className="space-y-6">
          <div className="space-y-3">
            {active.map((i) => <InstinctRow key={i.id} i={i} onAct={act} />)}
          </div>
          {retired.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Emekli ({retired.length})</h2>
              <div className="space-y-3 opacity-60">
                {retired.map((i) => <InstinctRow key={i.id} i={i} onAct={act} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InstinctRow({ i, onAct }: { i: any; onAct: (id: string, a: 'retire' | 'restore') => void }) {
  const conf = Number(i.confidence);
  return (
    <Card className="flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{i.lesson}</p>
        <p className="mt-1 text-xs text-muted-foreground">Tetikleyici: {i.trigger} · Kanıt: {i.evidence_count} · Kaynak: {i.source}</p>
      </div>
      <div className="w-32 shrink-0">
        <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>güven</span><span className="font-mono">{conf.toFixed(2)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={`h-full ${conf >= 0.6 ? 'bg-emerald-500' : conf >= 0.4 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.round(conf * 100)}%` }} />
        </div>
      </div>
      <Badge variant={conf >= 0.6 ? 'success' : 'neutral'}>{conf >= 0.6 ? 'enjekte' : 'pasif'}</Badge>
      {i.status === 'active'
        ? <Button variant="ghost" size="sm" title="Emekli et" onClick={() => onAct(i.id, 'retire')}><Archive className="size-4" /></Button>
        : <Button variant="ghost" size="sm" title="Geri getir" onClick={() => onAct(i.id, 'restore')}><RotateCcw className="size-4" /></Button>}
    </Card>
  );
}
