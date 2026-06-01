'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input, Textarea } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Target, ArrowRight } from 'lucide-react';

const STATUS_VARIANT: Record<string, any> = { planning: 'warning', running: 'default', blocked: 'danger', done: 'success', failed: 'danger' };

export default function MissionsPage() {
  const [missions, setMissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() { try { setMissions(await api('/missions')); } finally { setLoading(false); } }
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  async function create() {
    setBusy(true);
    try {
      await api('/missions', { method: 'POST', body: JSON.stringify({ title: title || goal, goal }) });
      setTitle(''); setGoal('');
      toast.success('Mission launched — planning the team…');
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="Mission Pods" subtitle="Give a business goal — a lead AI Resource assembles a team, splits the work into a dependency graph, and drives it to completion." />

      <Card className="mb-6 p-5">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <Input placeholder="Mission title (e.g. Win the Agrozan F&O upsell)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="Describe the goal/outcome you want the team to achieve…" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={create} disabled={!goal.trim() || busy}><Target className="size-4" />{busy ? 'Launching…' : 'Launch mission'}</Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : missions.length === 0 ? (
        <EmptyState icon={Target} title="No missions yet" hint="Launch one above to see the team self-organize." />
      ) : (
        <div className="grid gap-3">
          {missions.map((m) => {
            const done = m.summary?.done; const total = m._count?.tasks;
            return (
              <Link key={m.id} href={`/missions/${m.id}`}>
                <Card className="flex items-center justify-between p-4 transition-shadow hover:shadow-md">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{m.title}</span>
                      <Badge variant={STATUS_VARIANT[m.status] ?? 'neutral'}>{m.status}</Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{m.goal}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-sm text-muted-foreground">
                    {m.lead_resource && <span className="hidden sm:inline">Lead: {m.lead_resource.name}</span>}
                    <span className="font-mono tnum">{typeof done === 'number' ? `${done}/${total ?? '?'}` : `${total ?? 0} tasks`}</span>
                    <ArrowRight className="size-4" />
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
