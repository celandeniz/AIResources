'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { ShieldAlert, ShieldCheck, RefreshCw } from 'lucide-react';

const SEV_VARIANT: Record<string, 'danger' | 'warning' | 'default' | 'neutral'> = {
  critical: 'danger', high: 'danger', medium: 'warning', low: 'neutral',
};

export default function SecurityAuditPage() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => { setData(await api('/security-audit')); setLoading(false); }, []);
  useEffect(() => { load().catch((e) => { toast.error(e.message); setLoading(false); }); }, [load]);

  const score = data?.score ?? 0;
  const bySeverity: Record<string, any[]> = {};
  for (const f of data?.findings ?? []) (bySeverity[f.severity] ??= []).push(f);

  return (
    <div>
      <PageHeader
        title="Security Audit"
        subtitle="AgentShield tarzı konfigürasyon taraması — riskli tool kombinasyonları, eksik limitler, kimlik bilgisi uyumsuzlukları."
        actions={<Button variant="outline" onClick={() => { setLoading(true); load(); }}><RefreshCw className="size-4" /> Yeniden tara</Button>}
      />
      {loading ? (
        <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>
      ) : (
        <div className="space-y-5">
          <Card className="flex items-center gap-6 p-6">
            <div className={`grid size-20 place-items-center rounded-full border-4 ${score >= 80 ? 'border-emerald-500' : score >= 50 ? 'border-amber-500' : 'border-red-500'}`}>
              <span className="font-display text-2xl">{score}</span>
            </div>
            <div>
              <p className="font-medium">{score >= 80 ? 'İyi durumda' : score >= 50 ? 'Dikkat gerektiren bulgular var' : 'Kritik bulgular var'}</p>
              <p className="mt-1 text-sm text-muted-foreground">{(data?.findings ?? []).length} bulgu · {new Date(data?.scannedAt).toLocaleString('tr-TR')}</p>
            </div>
          </Card>
          {!(data?.findings ?? []).length ? (
            <EmptyState icon={ShieldCheck} title="Bulgu yok" hint="Tüm kontroller temiz geçti." />
          ) : (
            ['critical', 'high', 'medium', 'low'].map((sev) => bySeverity[sev]?.length > 0 && (
              <Card key={sev} className="p-5">
                <SectionTitle right={<Badge variant={SEV_VARIANT[sev]}>{bySeverity[sev].length}</Badge>}>{sev}</SectionTitle>
                <ul className="space-y-3">
                  {bySeverity[sev].map((f: any) => (
                    <li key={f.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-start gap-2">
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="text-sm"><span className="font-medium">{f.entity}</span> — {f.finding}</p>
                          <p className="mt-1 text-xs text-muted-foreground">Çözüm: {f.remediation}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
