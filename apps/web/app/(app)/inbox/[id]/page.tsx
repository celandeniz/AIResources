'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '../../../../lib/api';
import { PageHeader, StatusBadge, ChannelChip, ConfidenceDial } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Avatar } from '../../../../components/ui/misc';
import { relativeTime } from '../../../../lib/utils';
import { ArrowLeft, Sparkles, Wrench, Cpu, ChevronRight, ThumbsUp, ThumbsDown, UserCheck } from 'lucide-react';
import { toast } from '../../../../components/ui/toaster';

export default function ActivityDetail() {
  const { id } = useParams<{ id: string }>();
  const [a, setA] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { setA(await api(`/activities/${id}`)); } catch (e: any) { setErr(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (err) return <Card className="p-6 text-danger">{err}</Card>;
  if (!a) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><div className="grid gap-5 lg:grid-cols-5"><Skeleton className="h-80 lg:col-span-3" /><Skeleton className="h-80 lg:col-span-2" /></div></div>;

  const run = a.agent_runs?.[0];
  const usage = run?.output?.token_usage ?? {};

  return (
    <div>
      <Link href="/inbox" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-4" /> Inbox</Link>
      <PageHeader
        title={a.subject || '(no subject)'}
        subtitle={a.summary || undefined}
        actions={<StatusBadge status={a.status} />}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <ChannelChip channel={a.channel} />
        {a.customer?.name && <Badge variant="neutral">{a.customer.name}</Badge>}
        {a.project?.name && <Badge variant="outline">{a.project.name}</Badge>}
        {a.assigned_resource?.name && <Badge variant="default"><Sparkles className="size-3" />{a.assigned_resource.name}</Badge>}
        <span className="text-xs text-muted-foreground">· {relativeTime(a.received_at)}</span>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* Conversation / timeline */}
        <div className="space-y-3 lg:col-span-3">
          {(a.messages ?? []).map((m: any) => (
            <Card key={m.id} className="p-4">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Avatar name={m.author_type === 'ai_resource' ? (a.assigned_resource?.name ?? 'AI') : m.from_address} className="size-6 text-[10px]" />
                <span className="font-medium text-foreground capitalize">{m.author_type.replace('_', ' ')}</span>
                {m.is_draft && <Badge variant="warning">draft</Badge>}
                {m.sent_at && <Badge variant="success">sent</Badge>}
                <span className="ml-auto">{relativeTime(m.created_at)}</span>
              </div>
              {m.subject && <div className="mb-1 font-medium">{m.subject}</div>}
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{m.body}</p>
            </Card>
          ))}
          {!a.messages?.length && <Card className="p-8 text-center text-sm text-muted-foreground">No messages.</Card>}
        </div>

        {/* Explainability panel — signature */}
        <div className="lg:col-span-2">
          <Card className="sticky top-20 overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-5 py-3">
              <Sparkles className="size-4 text-primary" />
              <span className="text-sm font-semibold">AI Explainability</span>
            </div>
            {run ? (
              <div className="divide-y divide-border">
                <div className="flex items-center gap-4 p-5">
                  <ConfidenceDial value={run.confidence_score != null ? Number(run.confidence_score) : null} size={76} />
                  <div className="min-w-0">
                    <div className="font-medium">{run.ai_resource?.name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Cpu className="size-3" />{run.llm_provider} · {run.llm_model}
                    </div>
                    {usage.fallback && <Badge variant="warning" className="mt-1.5">stub fallback</Badge>}
                  </div>
                </div>

                <div className="p-5">
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reasoning</div>
                  <p className="text-sm leading-relaxed text-foreground/90">{run.reasoning_summary || '—'}</p>
                </div>

                <div className="p-5">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Proposed actions</div>
                  <div className="space-y-1.5">
                    {(run.tool_calls ?? []).map((tc: any) => (
                      <div key={tc.id} className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
                        <Wrench className="size-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs">{tc.name}</span>
                        <span className="ml-auto"><StatusBadge status={tc.status} /></span>
                      </div>
                    ))}
                    {!run.tool_calls?.length && <p className="text-sm text-muted-foreground">No tool actions.</p>}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-px bg-border text-center">
                  <Meta label="Latency" value={run.latency_ms != null ? `${run.latency_ms}ms` : '—'} />
                  <Meta label="In tokens" value={usage.input ?? '—'} />
                  <Meta label="Out tokens" value={usage.output ?? '—'} />
                </div>

                {run.output?.review && (
                  <PeerReviewBlock review={run.output.review} />
                )}

                <FeedbackBar runId={run.id} />

                {a.approvals?.filter((x: any) => x.status === 'pending').length > 0 && (
                  <Link href="/approvals" className="flex items-center justify-between bg-warning/8 px-5 py-3.5 text-sm font-medium text-warning transition-colors hover:bg-warning/15">
                    Pending approval — review now <ChevronRight className="size-4" />
                  </Link>
                )}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">No agent run yet.</div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function PeerReviewBlock({ review }: { review: any }) {
  const verdictVariant = review.verdict === 'approve' ? 'success' : 'warning';
  return (
    <div className="p-5 border-t border-border">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <UserCheck className="size-3.5" /> Peer Review
      </div>
      <div className="flex items-center gap-2 mb-2">
        <Badge variant={verdictVariant}>{review.verdict}</Badge>
        <span className="text-xs text-muted-foreground">by {review.reviewer_name}</span>
        {review.score != null && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">score {(review.score * 100).toFixed(0)}%</span>
        )}
      </div>
      {review.comments && (
        <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">{review.comments}</p>
      )}
    </div>
  );
}

function FeedbackBar({ runId }: { runId: string }) {
  const [done, setDone] = useState<string | null>(null);
  async function rate(rating: 'up' | 'down') {
    setDone(rating);
    try { await api(`/agent-runs/${runId}/feedback`, { method: 'POST', body: JSON.stringify({ rating }) }); toast.success('Thanks — feedback recorded'); }
    catch (e: any) { toast.error(e.message); setDone(null); }
  }
  return (
    <div className="flex items-center justify-between px-5 py-3 text-sm">
      <span className="text-muted-foreground">Was this draft helpful?</span>
      <div className="flex gap-1.5">
        <Button size="icon" variant={done === 'up' ? 'success' : 'outline'} onClick={() => rate('up')} disabled={!!done}><ThumbsUp className="size-4" /></Button>
        <Button size="icon" variant={done === 'down' ? 'danger' : 'outline'} onClick={() => rate('down')} disabled={!!done}><ThumbsDown className="size-4" /></Button>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-card p-3">
      <div className="font-mono text-sm font-semibold tnum">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
