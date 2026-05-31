'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { PageHeader, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Skeleton } from '../../../components/ui/skeleton';
import { Workflow, ArrowRight } from 'lucide-react';

export default function WorkflowsPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { api('/workflow-rules').then((d) => { setRules(d); setLoading(false); }).catch(() => setLoading(false)); }, []);

  return (
    <div>
      <PageHeader title="Workflow Engine" subtitle="Rules that route every inbound activity to the right AI Resource." />
      {loading ? <div className="space-y-2">{[0,1,2,3].map(i => <Skeleton key={i} className="h-14" />)}</div>
       : rules.length === 0 ? <EmptyState icon={Workflow} title="No rules configured" />
       : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-4 py-2.5 text-left font-medium">Priority</th><th className="px-4 py-2.5 text-left font-medium">Rule</th><th className="px-4 py-2.5 text-left font-medium">Phase</th><th className="px-4 py-2.5 text-left font-medium">Routes to</th><th className="px-4 py-2.5 text-left font-medium">Status</th></tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-border transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3 font-mono tnum text-muted-foreground">{r.priority}</td>
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3"><Badge variant={r.phase === 'post_agent' ? 'warning' : 'neutral'}>{r.phase}</Badge></td>
                  <td className="px-4 py-3">{r.target_resource ? <span className="inline-flex items-center gap-1.5 text-primary"><ArrowRight className="size-3.5" />{r.target_resource.name}</span> : <span className="text-muted-foreground">{r.action_type}</span>}</td>
                  <td className="px-4 py-3"><Badge variant={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'active' : 'off'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
