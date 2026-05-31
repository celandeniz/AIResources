'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { Switch } from '../../../components/ui/misc';
import { Repeat } from 'lucide-react';

const CADENCE_VARIANT: Record<string, any> = {
  daily: 'danger',
  weekly: 'warning',
  monthly: 'default',
  quarterly: 'neutral',
};

export default function AutomationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await api('/automations');
    setItems(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, [load]);

  // Group by resource name
  const grouped: Record<string, any[]> = {};
  for (const item of items) {
    const key = item.resource?.name ?? 'Unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  const groups = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));

  async function toggleActive(id: string, value: boolean) {
    try {
      await api(`/automations/${id}`, { method: 'PATCH', body: JSON.stringify({ is_active: value }) });
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, is_active: value } : a)));
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function runNow(id: string, name: string) {
    try {
      await api(`/automations/${id}/run`, { method: 'POST' });
      toast.success(`"${name}" queued for immediate run`);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Proactive Automations"
        subtitle="Recurring jobs that draft tasks and hand off work across departments."
      />
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Repeat}
          title="No automations configured"
          hint="Seed the database to generate proactive automations for each resource."
        />
      ) : (
        <div className="space-y-8">
          {groups.map(([resourceName, automations]) => (
            <section key={resourceName}>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-semibold">{resourceName}</h2>
                <Badge variant="neutral">{automations.length}</Badge>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {automations.map((a) => (
                  <AutomationCard
                    key={a.id}
                    automation={a}
                    onToggle={(val) => toggleActive(a.id, val)}
                    onRun={() => runNow(a.id, a.name)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AutomationCard({
  automation: a,
  onToggle,
  onRun,
}: {
  automation: any;
  onToggle: (val: boolean) => void;
  onRun: () => void;
}) {
  const [running, setRunning] = useState(false);
  const handoffTo: string[] = Array.isArray(a.handoff_to) ? a.handoff_to : [];

  async function handleRun() {
    setRunning(true);
    try {
      await onRun();
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.name}</span>
            <Badge variant={CADENCE_VARIANT[a.cadence] ?? 'neutral'}>{a.cadence}</Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{a.objective}</p>
        </div>
        <Switch
          checked={a.is_active}
          onCheckedChange={onToggle}
          aria-label={`Toggle ${a.name}`}
        />
      </div>

      {handoffTo.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground">Hands off to:</span>
          {handoffTo.map((key: string) => (
            <Badge key={key} variant="outline" className="font-mono text-[10px]">{key}</Badge>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-3">
        <div className="flex gap-3 text-xs text-muted-foreground">
          <span>Runs: <span className="font-mono tnum font-medium text-foreground">{a.run_count ?? 0}</span></span>
          {a.next_run_at && (
            <span>
              Next:{' '}
              <span className="font-medium text-foreground">
                {new Date(a.next_run_at).toLocaleString()}
              </span>
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={handleRun} disabled={running}>
          {running ? 'Running…' : 'Run now'}
        </Button>
      </div>
    </Card>
  );
}
