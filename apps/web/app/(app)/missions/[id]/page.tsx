'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { MessageSquare, GitBranch, CheckCircle2, XCircle, Trash2, ExternalLink } from 'lucide-react';

const STATUS_VARIANT: Record<string, any> = { planning: 'warning', running: 'default', blocked: 'danger', done: 'success', failed: 'danger' };
const COLS: { key: string; label: string }[] = [
  { key: 'open', label: 'Queued / Blocked' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
];

export default function MissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [m, setM] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  async function load() { try { setM(await api(`/missions/${id}`)); } finally { setLoading(false); } }
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!m || ['planning', 'running', 'blocked'].includes(m.status)) load(); }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, m?.status]);

  if (loading && !m) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-64" /></div>;
  if (!m) return <p className="text-sm text-muted-foreground">Mission not found.</p>;

  const tasks: any[] = m.tasks ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;
  const colTasks = (k: string) => (k === 'open' ? tasks.filter((t) => t.status === 'open' || t.status === 'failed') : tasks.filter((t) => t.status === k));

  const summary = (m.summary as any) ?? {};
  const planPending = Boolean(summary.plan_pending);

  async function planAction(action: 'approve-plan' | 'reject-plan') {
    try {
      await api(`/missions/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      toast.success(action === 'approve-plan' ? 'Plan onaylandı — pod çalışıyor' : 'Plan reddedildi');
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  async function removeTask(taskId: string) {
    try {
      await api(`/missions/${id}/tasks/${taskId}`, { method: 'POST', body: JSON.stringify({ remove: true }) });
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  return (
    <div>
      <PageHeader title={m.title} subtitle={m.goal} />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Badge variant={STATUS_VARIANT[m.status] ?? 'neutral'}>{m.status}</Badge>
        {summary.template && <Badge variant="outline">pod: {summary.template}</Badge>}
        {summary.dev?.branch && <Badge variant="outline"><GitBranch className="size-3" />{summary.dev.branch}</Badge>}
        {summary.dev?.pr_url && (
          <a href={summary.dev.pr_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            PR <ExternalLink className="size-3" />
          </a>
        )}
        {m.lead_resource && <span className="text-sm text-muted-foreground">Lead: <span className="font-medium text-foreground">{m.lead_resource.name}</span></span>}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-2 w-40 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
          <span className="font-mono tnum">{doneCount}/{tasks.length} · {pct}%</span>
        </div>
      </div>

      {planPending && (
        <Card className="mb-5 border-amber-500/40 bg-amber-500/5 p-5">
          <SectionTitle right={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => planAction('approve-plan')}><CheckCircle2 className="size-4" /> Planı Onayla</Button>
              <Button size="sm" variant="outline" onClick={() => planAction('reject-plan')}><XCircle className="size-4" /> Reddet</Button>
            </div>
          }>Plan Canvas — insan onayı bekliyor</SectionTitle>
          <ol className="space-y-2">
            {tasks.map((t, i) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{t.title}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    {(t.metadata as any)?.kind && (t.metadata as any).kind !== 'agent' && <Badge variant="default">{(t.metadata as any).kind}</Badge>}
                    {t.assignee_resource && <Badge variant="outline">{t.assignee_resource.name}</Badge>}
                    {((t.depends_on as string[]) ?? []).length > 0 && <span className="text-xs text-muted-foreground">← {((t.depends_on as string[]) ?? []).length} bağımlılık</span>}
                  </div>
                </div>
                <Button variant="ghost" size="sm" title="Aşamayı kaldır" onClick={() => removeTask(t.id)}><Trash2 className="size-3.5" /></Button>
              </li>
            ))}
          </ol>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        {/* Task board */}
        <div className="grid gap-4 md:grid-cols-3">
          {COLS.map((c) => (
            <div key={c.key}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{c.label} ({colTasks(c.key).length})</div>
              <div className="space-y-2">
                {colTasks(c.key).map((t) => {
                  const deps = (t.depends_on as string[]) ?? [];
                  const blocked = t.status === 'open' && deps.some((d) => byId.get(d)?.status !== 'done');
                  return (
                    <Card key={t.id} className="p-3">
                      <div className="text-sm font-medium leading-snug">{t.title}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {t.assignee_resource && <Badge variant="outline">{t.assignee_resource.name}</Badge>}
                        {blocked && <Badge variant="warning"><GitBranch className="size-3" />blocked ×{deps.length}</Badge>}
                        {t.status === 'failed' && <Badge variant="danger">failed</Badge>}
                      </div>
                    </Card>
                  );
                })}
                {!colTasks(c.key).length && <p className="text-xs text-muted-foreground">—</p>}
              </div>
            </div>
          ))}
        </div>

        {/* Mission feed */}
        <Card className="p-4">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><MessageSquare className="size-4" />Mission feed</span></SectionTitle>
          <div className="space-y-2.5">
            {(m.messages ?? []).map((msg: any) => (
              <div key={msg.id} className="rounded-lg border border-border bg-muted/20 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{msg.from_resource?.name ?? 'system'}</span>
                  <Badge variant={msg.kind === 'plan' ? 'default' : 'neutral'}>{msg.kind}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{msg.body}</p>
              </div>
            ))}
            {!(m.messages ?? []).length && <p className="text-sm text-muted-foreground">No messages yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
