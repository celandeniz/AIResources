'use client';
import * as React from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { api, apiStreamUrl } from '../../../lib/api';
import { PageHeader } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { toast } from '../../../components/ui/toaster';

export default function NotificationsPage() {
  const [items, setItems] = React.useState<any[]>([]);
  const load = React.useCallback(async () => setItems(await api('/notifications')), []);

  React.useEffect(() => {
    load().catch(() => {});
    let fallback: ReturnType<typeof setInterval> | undefined;
    try {
      const es = new EventSource(apiStreamUrl('/stream'));
      es.addEventListener('notification', () => load().catch(() => {}));
      es.addEventListener('approval', () => load().catch(() => {}));
      es.onerror = () => {
        es.close();
        fallback = setInterval(() => load().catch(() => {}), 8000);
      };
      return () => { es.close(); if (fallback) clearInterval(fallback); };
    } catch {
      fallback = setInterval(() => load().catch(() => {}), 8000);
      return () => { if (fallback) clearInterval(fallback); };
    }
  }, [load]);

  async function markAllRead() {
    await api('/notifications/mark-read', { method: 'POST' });
    toast.success('Notifications marked read');
    await load();
  }

  async function markRead(id: string) {
    await api(`/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({ read: true }) });
    await load();
  }

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Approval, escalation, and system events." />
      <div className="mb-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={markAllRead}><CheckCheck />Mark all read</Button>
      </div>
      <div className="space-y-3">
        {items.map((n) => (
          <Card key={n.id} className="flex items-start gap-3 p-4">
            <div className="mt-0.5 grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground"><Bell className="size-4" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="font-medium">{n.title}</div>
                <Badge variant={n.read ? 'neutral' : 'default'}>{n.read ? 'read' : 'new'}</Badge>
                <Badge variant="outline">{n.type}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{n.message}</p>
              <div className="mt-2 text-xs text-muted-foreground">{new Date(n.created_at).toLocaleString()}</div>
            </div>
            {!n.read && <Button variant="ghost" size="sm" onClick={() => markRead(n.id)}>Mark read</Button>}
          </Card>
        ))}
        {items.length === 0 && <Card className="p-6 text-sm text-muted-foreground">No notifications.</Card>}
      </div>
    </div>
  );
}
