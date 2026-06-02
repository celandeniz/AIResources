'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input, Select } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { FileBarChart, Plus, Clock } from 'lucide-react';

interface Org { id: string; org_name: string; display_name: string; }
interface ReportRow {
  id: string;
  title: string;
  scope: string;
  org_label: string;
  project_label?: string;
  period_label: string;
  status: string;
  created_at: string;
}

const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  sent: 'warning',
  ordered: 'success',
};

function MonthPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      type="month"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-48"
    />
  );
}

export default function ReportsPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Form state
  const [scope, setScope] = useState<'organization' | 'project'>('organization');
  const [customerId, setCustomerId] = useState('');
  const [projectLabel, setProjectLabel] = useState('');
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [byTask, setByTask] = useState(true);
  const [byResource, setByResource] = useState(true);
  const [hourlyRate, setHourlyRate] = useState('');
  const [currency, setCurrency] = useState('TRY');

  useEffect(() => {
    api('/reports/organizations').then((d: any[]) => setOrgs(d ?? [])).catch(() => {});
    api('/reports').then((d: any[]) => {
      setReports(d ?? []);
      setLoadingHistory(false);
    }).catch(() => setLoadingHistory(false));
  }, []);

  useEffect(() => {
    if (scope === 'project' && customerId) {
      api(`/reports/projects?customerId=${customerId}`)
        .then((d: string[]) => setProjects(d ?? []))
        .catch(() => setProjects([]));
    } else {
      setProjects([]);
      setProjectLabel('');
    }
  }, [scope, customerId]);

  async function generate() {
    if (!customerId) { toast.error('Please select an organisation'); return; }
    if (scope === 'project' && !projectLabel) { toast.error('Please select a project'); return; }
    if (!month) { toast.error('Please select a month'); return; }

    const [year, mon] = month.split('-').map(Number);
    const from = `${year}-${String(mon).padStart(2, '0')}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const to = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const periodLabel = new Date(year, mon - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });

    setBusy(true);
    try {
      const row: any = await api('/reports', {
        method: 'POST',
        body: JSON.stringify({
          scope,
          customerId,
          projectLabel: scope === 'project' ? projectLabel : undefined,
          periodLabel,
          from,
          to,
          grouping: { byTask, byResource },
          hourlyRate: hourlyRate ? Number(hourlyRate) : undefined,
          currency: currency || 'TRY',
        }),
      });
      router.push(`/reports/${row.id}`);
    } catch (e: any) {
      toast.error(e.message ?? 'Report generation failed');
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Work Reports"
        subtitle="Generate branded time-log / work reports and create Business Central sales orders."
        actions={<Badge variant="neutral"><FileBarChart className="size-3" />Reports</Badge>}
      />

      {/* Generate card */}
      <Card className="mb-8 p-6">
        <SectionTitle>Generate Report</SectionTitle>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Scope */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Scope</label>
            <div className="flex gap-2">
              {(['organization', 'project'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                    scope === s
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/40'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Organisation */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Organisation</label>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— select —</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.display_name || o.org_name}</option>
              ))}
            </Select>
          </div>

          {/* Project (when scope=project) */}
          {scope === 'project' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Project</label>
              <Select value={projectLabel} onChange={(e) => setProjectLabel(e.target.value)}>
                <option value="">— select —</option>
                {projects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </div>
          )}

          {/* Month */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Month</label>
            <MonthPicker value={month} onChange={setMonth} />
          </div>

          {/* Hourly rate */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Hourly Rate (optional)</label>
            <div className="flex gap-2">
              <Input
                type="number"
                placeholder="e.g. 150"
                value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)}
                className="flex-1"
              />
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-24">
                {['TRY', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {/* Grouping toggles */}
        <div className="mt-4 flex flex-wrap gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={byTask}
              onChange={(e) => setByTask(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Include task totals</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={byResource}
              onChange={(e) => setByResource(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span>Include resource totals</span>
          </label>
        </div>

        <div className="mt-5">
          <Button onClick={generate} disabled={busy || !customerId}>
            <Plus className="size-4" />
            {busy ? 'Generating…' : 'Generate Report'}
          </Button>
        </div>
      </Card>

      {/* History */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <SectionTitle>Recent Reports</SectionTitle>
        </div>

        {loadingHistory ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : reports.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No reports yet. Generate one above.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3">Report</th>
                <th className="px-5 py-3">Scope</th>
                <th className="px-5 py-3">Period</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                  onClick={() => router.push(`/reports/${r.id}`)}
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{r.org_label}</div>
                    {r.project_label && (
                      <div className="text-xs text-muted-foreground">{r.project_label}</div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Badge variant="neutral" className="text-xs capitalize">{r.scope}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{r.period_label}</td>
                  <td className="px-5 py-3">
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'neutral'} className="capitalize">{r.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Clock className="size-3" />
                      {new Date(r.created_at).toLocaleDateString('tr-TR')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
