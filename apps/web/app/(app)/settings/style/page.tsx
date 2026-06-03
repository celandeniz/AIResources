'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Sparkles, Mail, MessageSquare, GitBranch, RefreshCw } from 'lucide-react';

export default function StylePage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [examples, setExamples] = useState<any[]>([]);

  async function load() {
    const s = await api('/style/status');
    setStatus(s);
    setLoading(false);
    api('/style/examples?limit=10').then(setExamples).catch(() => {});
  }
  useEffect(() => { load().catch(() => setLoading(false)); }, []);

  async function learn() {
    setLearning(true);
    try {
      const r = await api('/style/learn', { method: 'POST', body: JSON.stringify({ sources: { email: true, teams: true, devops: true }, months: 12 }) });
      const e = r?.email?.learned ?? 0;
      toast.success(`Öğrenme tamamlandı — ${e} e-posta örneği işlendi${r?.profile_updated ? ', stil profili güncellendi' : ''}.`);
      if (r?.teams?.note) toast.message?.('Teams', { description: r.teams.note });
      load();
    } catch (e: any) { toast.error(e.message ?? 'Öğrenme başarısız'); } finally { setLearning(false); }
  }

  const counts = status?.examples ?? {};

  return (
    <div>
      <PageHeader title="Yanıt Stilim" subtitle="Geçmiş yanıtlarından stilini öğren — tüm AI taslakları senin sesinle yazılsın." />

      {loading ? <Skeleton className="h-40" /> : (
        <div className="space-y-5">
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2"><Mail className="size-4 text-muted-foreground" /><span className="text-sm">E-posta örnekleri: <strong>{counts.email ?? 0}</strong></span></div>
              <div className="flex items-center gap-2"><MessageSquare className="size-4 text-muted-foreground" /><span className="text-sm">Teams: <strong>{counts.teams ?? 0}</strong></span></div>
              <div className="flex items-center gap-2"><GitBranch className="size-4 text-muted-foreground" /><span className="text-sm">DevOps: <strong>{counts.devops ?? 0}</strong></span></div>
              {!status?.graph_configured && <Badge variant="warning">Graph bağlı değil</Badge>}
              <div className="ml-auto">
                <Button onClick={learn} disabled={learning}>
                  {learning ? <RefreshCw className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {learning ? 'Öğreniyor…' : 'Stilimi öğren'}
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Gönderilmiş e-postaların (deniz@) Graph üzerinden canlı taranır. Teams kanal geçmişi ve Azure DevOps yorumları, ilgili bağlantılar/izinler kurulunca otomatik dahil edilir.
            </p>
          </Card>

          <div>
            <SectionTitle>Öğrenilen stil profili</SectionTitle>
            <Card className="p-5">
              {status?.profile?.text ? (
                <>
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="success">aktif</Badge>
                    <span>{status.profile.sample_count} örnekten · güncellendi {new Date(status.profile.updated_at).toLocaleString('tr-TR')}</span>
                  </div>
                  <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-sm leading-relaxed">{status.profile.text}</pre>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Henüz stil profili yok. "Stilimi öğren"e bas — geçmiş yanıtlarından profilini çıkaracağım.</p>
              )}
            </Card>
          </div>

          {examples.length > 0 && (
            <div>
              <SectionTitle>Son örnekler</SectionTitle>
              <div className="space-y-2">
                {examples.map((e) => (
                  <Card key={e.id} className="p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{e.channel}</Badge>
                      <span className="font-medium text-foreground">{e.subject || e.topic}</span>
                      {e.sent_at && <span className="ml-auto">{new Date(e.sent_at).toLocaleDateString('tr-TR')}</span>}
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-sm text-muted-foreground">{e.reply_text}</p>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
