'use client';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { api, apiStreamUrl } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, StatusBadge, ChannelChip, EmptyState, ConfidenceDial } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Select } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Avatar } from '../../../components/ui/misc';
import { relativeTime } from '../../../lib/utils';
import { Mail, RefreshCw, Inbox as InboxIcon } from 'lucide-react';

export default function InboxPage() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api(`/activities${status ? `?status=${status}` : ''}`);
    setItems(r.data ?? []);
    setLoading(false);
  }, [status]);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  useEffect(() => {
    let fallback: ReturnType<typeof setInterval> | undefined;
    try {
      const es = new EventSource(apiStreamUrl('/stream'));
      es.addEventListener('activity', () => load().catch(() => {}));
      es.addEventListener('approval', () => load().catch(() => {}));
      es.onerror = () => { es.close(); fallback = setInterval(() => load().catch(() => {}), 8000); };
      return () => { es.close(); if (fallback) clearInterval(fallback); };
    } catch {
      fallback = setInterval(() => load().catch(() => {}), 8000);
      return () => { if (fallback) clearInterval(fallback); };
    }
  }, [load]);

  async function triggerMock() {
    setBusy(true);
    try {
      await api('/activities/trigger-mock-email', { method: 'POST' });
      toast.success('Mock email ingested', { description: 'Routing & drafting in progress…' });
      setTimeout(load, 1500);
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader
        title="Activity Inbox"
        subtitle="Every inbound activity across all connections — triaged and routed."
        actions={
          <>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">All statuses</option>
              <option value="new">New</option>
              <option value="watching">Watching</option>
              <option value="awaiting_approval">Awaiting approval</option>
              <option value="completed">Completed</option>
              <option value="escalated">Escalated</option>
            </Select>
            <Button variant="outline" size="icon" onClick={() => load()}><RefreshCw className="size-4" /></Button>
            <Button onClick={triggerMock} disabled={busy}><Mail className="size-4" />{busy ? 'Working…' : 'Trigger mock email'}</Button>
          </>
        }
      />

      {loading ? (
        <div className="space-y-2">{[0,1,2,3,4].map(i => <Skeleton key={i} className="h-16" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={InboxIcon} title="No activities yet" hint="Connect Outlook/Teams or trigger a mock email to see the flow." action={<Button onClick={triggerMock}><Mail className="size-4" />Trigger mock email</Button>} />
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {items.map((a) => (
            <Link key={a.id} href={`/inbox/${a.id}`} className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-muted/40">
              <ConfidenceDial value={a.confidence != null ? Number(a.confidence) : null} size={44} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{a.subject || '(no subject)'}</span>
                  <ChannelChip channel={a.channel} />
                </div>
                <div className="mt-0.5 truncate text-sm text-muted-foreground">{a.summary || a.body || '—'}</div>
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                {a.customer?.name && <span className="text-xs text-muted-foreground">{a.customer.name}</span>}
              </div>
              {a.assigned_resource?.name && (
                <div className="hidden items-center gap-2 md:flex">
                  <Avatar name={a.assigned_resource.name} className="size-6 text-[10px]" />
                  <span className="text-xs text-muted-foreground">{a.assigned_resource.name.replace('AI ', '')}</span>
                </div>
              )}
              <div className="w-32 text-right text-xs text-muted-foreground">{relativeTime(a.received_at)}</div>
              <StatusBadge status={a.status} />
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}
