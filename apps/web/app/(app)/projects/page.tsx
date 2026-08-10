'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { FolderKanban, RefreshCw, AlertTriangle, Radar, Target } from 'lucide-react';

const HEALTH_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  green: 'success', amber: 'warning', red: 'danger',
};

export default function ProjectsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setItems(await api('/projects'));
    setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function syncCosmos() {
    setSyncing(true);
    try {
      const r: any = await api('/projects/sync-cosmos', { method: 'POST' });
      toast.success(`Senkronize edildi — ${r.created} yeni proje (${r.seen} görüldü)`);
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setSyncing(false); }
  }

  async function syncAdo() {
    setSyncing(true);
    try {
      const r: any = await api('/projects/sync-ado', { method: 'POST' });
      toast.success(`ADO taraması bitti — ${r.projects} proje güncellendi, ${r.created} yeni`);
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setSyncing(false); }
  }

  const active = items.filter((p) => p.status === 'active');
  const other = items.filter((p) => p.status !== 'active');
  const rank = (p: any) => (p.health === 'red' ? 0 : p.health === 'amber' ? 1 : p.counts?.overdue ? 2 : 3);
  active.sort((a, b) => rank(a) - rank(b));

  return (
    <div>
      <PageHeader
        title="Projeler"
        subtitle="ADO + e-posta + Teams ile senkron proje portföyü — canlı durum ve haftalık yapılacaklar."
        actions={
          <>
            <Button onClick={syncAdo} disabled={syncing}>
              <RefreshCw className={syncing ? 'size-4 animate-spin' : 'size-4'} /> ADO&apos;dan tara
            </Button>
            <Button onClick={syncCosmos} disabled={syncing} variant="outline">
              Cosmos&apos;tan senkronize et
            </Button>
          </>
        }
      />
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-40" />)}</div>
      ) : !items.length ? (
        <EmptyState icon={FolderKanban} title="Henüz proje yok" hint="Cosmos'tan senkronize et ile DynOpsCore projelerini içeri alın." />
      ) : (
        <div className="space-y-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {active.map((p) => <ProjectCard key={p.id} p={p} />)}
          </div>
          {other.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Pasif / kapalı ({other.length})</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 opacity-70">
                {other.map((p) => <ProjectCard key={p.id} p={p} />)}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: any }) {
  const c = p.counts ?? {};
  const byState = (p.metadata?.stats?.byState ?? {}) as Record<string, number>;
  const active = Object.entries(byState).filter(([s]) => /active|doing|progress/i.test(s)).reduce((n, [, v]) => n + v, 0);
  return (
    <Link href={`/projects/${p.id}`}>
      <Card className="group flex h-full flex-col p-5 transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{p.name}</div>
            <div className="mt-0.5 truncate text-sm text-muted-foreground">{p.customer?.name ?? '—'}</div>
          </div>
          {p.health ? (
            <Badge variant={HEALTH_VARIANT[p.health] ?? 'neutral'}>{p.health}</Badge>
          ) : (
            <Badge variant="neutral">—</Badge>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline">{c.openItems ?? 0} açık iş</Badge>
          {active > 0 && <Badge variant="default">{active} aktif</Badge>}
          {c.overdue > 0 && <Badge variant="danger"><AlertTriangle className="size-3" />{c.overdue} gecikmiş</Badge>}
          {c.stalledThreads > 0 && <Badge variant="warning"><Radar className="size-3" />{c.stalledThreads} takipsiz</Badge>}
          {c.runningMissions > 0 && <Badge variant="default"><Target className="size-3" />{c.runningMissions} mission</Badge>}
        </div>
        <div className="mt-3 line-clamp-1 text-xs text-muted-foreground">
          {[p.devops_project && `ADO: ${p.devops_project}`, p.teams_team_id && 'Teams ✓', p.cosmos_org_name].filter(Boolean).join(' · ') || 'Eşleme yapılmadı'}
        </div>
      </Card>
    </Link>
  );
}
