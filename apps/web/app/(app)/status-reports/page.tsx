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
import { ClipboardCheck, Plus, Clock } from 'lucide-react';

interface Org { id: string; org_name: string; display_name: string; }
interface StatusReportRow {
  id: string;
  title: string;
  org_label: string;
  project_label: string;
  period_label: string;
  period_start: string;
  period_end: string;
  health?: string;
  status: string;
  created_at: string;
}

const HEALTH_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};
const HEALTH_LABEL: Record<string, string> = { green: 'Yeşil', amber: 'Sarı', red: 'Kırmızı' };

export default function StatusReportsPage() {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [reports, setReports] = useState<StatusReportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Form state
  const [customerId, setCustomerId] = useState('');
  const [projectLabel, setProjectLabel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [useDevops, setUseDevops] = useState(true);
  const [useOutlook, setUseOutlook] = useState(true);
  const [keywords, setKeywords] = useState('');

  useEffect(() => {
    api('/reports/organizations').then((d: any[]) => setOrgs(d ?? [])).catch(() => {});
    api('/status-reports').then((d: any[]) => {
      setReports(d ?? []);
      setLoadingHistory(false);
    }).catch(() => setLoadingHistory(false));
  }, []);

  useEffect(() => {
    if (customerId) {
      api(`/reports/projects?customerId=${customerId}`)
        .then((d: string[]) => setProjects(d ?? []))
        .catch(() => setProjects([]));
    } else {
      setProjects([]);
      setProjectLabel('');
    }
  }, [customerId]);

  // Auto-prefill keywords with the selected project name.
  useEffect(() => {
    if (projectLabel) setKeywords(projectLabel);
  }, [projectLabel]);

  async function generate() {
    if (!customerId) { toast.error('Lütfen bir organizasyon seçin'); return; }
    if (!projectLabel) { toast.error('Lütfen bir proje seçin'); return; }
    if (!from || !to) { toast.error('Lütfen başlangıç ve bitiş tarihi seçin'); return; }

    const kwList = keywords.split(',').map((k) => k.trim()).filter(Boolean);

    setBusy(true);
    try {
      const row: any = await api('/status-reports', {
        method: 'POST',
        body: JSON.stringify({
          customerId,
          projectLabel,
          from,
          to,
          sources: { devops: useDevops, outlook: useOutlook, teams: false },
          keywords: kwList,
        }),
      });
      router.push(`/status-reports/${row.id}`);
    } catch (e: any) {
      toast.error(e.message ?? 'Durum raporu oluşturulamadı');
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Project Status Reports"
        subtitle="Azure DevOps iş öğeleri ve Outlook e-postalarından yapay zeka destekli proje durum raporu ve risk analizi."
        actions={<Badge variant="neutral"><ClipboardCheck className="size-3" />Project Status</Badge>}
      />

      {/* Generate card */}
      <Card className="mb-8 p-6">
        <SectionTitle>Durum Raporu Oluştur</SectionTitle>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Organisation */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Organizasyon</label>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— seçin —</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.display_name || o.org_name}</option>
              ))}
            </Select>
          </div>

          {/* Project */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Proje</label>
            <Select value={projectLabel} onChange={(e) => setProjectLabel(e.target.value)}>
              <option value="">— seçin —</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </Select>
          </div>

          {/* Keywords */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Anahtar Kelimeler (virgülle)</label>
            <Input
              placeholder="örn. portal, login, faz 2"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </div>

          {/* From */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Başlangıç</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>

          {/* To */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Bitiş</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        {/* Data sources */}
        <div className="mt-4">
          <label className="mb-2 block text-xs font-medium text-muted-foreground">Veri Kaynakları</label>
          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useDevops}
                onChange={(e) => setUseDevops(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span>Azure DevOps</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={useOutlook}
                onChange={(e) => setUseOutlook(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span>Outlook</span>
            </label>
            <label className="flex cursor-not-allowed items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={false}
                disabled
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span>Teams (kurulum bekliyor)</span>
            </label>
          </div>
        </div>

        <div className="mt-5">
          <Button onClick={generate} disabled={busy || !customerId || !projectLabel}>
            <Plus className="size-4" />
            {busy ? 'Oluşturuluyor…' : 'Durum Raporu Oluştur'}
          </Button>
        </div>
      </Card>

      {/* History */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <SectionTitle>Son Raporlar</SectionTitle>
        </div>

        {loadingHistory ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">Yükleniyor…</div>
        ) : reports.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Henüz rapor yok. Yukarıdan bir tane oluşturun.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3">Proje</th>
                <th className="px-5 py-3">Dönem</th>
                <th className="px-5 py-3">Durum</th>
                <th className="px-5 py-3">Tarih</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                  onClick={() => router.push(`/status-reports/${r.id}`)}
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{r.org_label}</div>
                    <div className="text-xs text-muted-foreground">{r.project_label}</div>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{r.period_label}</td>
                  <td className="px-5 py-3">
                    {r.health ? (
                      <Badge variant={HEALTH_VARIANT[r.health] ?? 'neutral'}>
                        {HEALTH_LABEL[r.health] ?? r.health}
                      </Badge>
                    ) : (
                      <Badge variant="neutral" className="capitalize">{r.status}</Badge>
                    )}
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
