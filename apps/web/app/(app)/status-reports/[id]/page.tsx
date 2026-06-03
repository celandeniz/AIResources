'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { ClipboardCheck, Printer, ArrowLeft } from 'lucide-react';

const HEALTH_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};
const HEALTH_LABEL: Record<string, string> = { green: 'Yeşil', amber: 'Sarı', red: 'Kırmızı' };
const SEVERITY_VARIANT: Record<string, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};
const SEVERITY_LABEL: Record<string, string> = { low: 'Düşük', medium: 'Orta', high: 'Yüksek' };

interface Risk {
  title: string;
  severity: 'low' | 'medium' | 'high';
  likelihood: 'low' | 'medium' | 'high';
  impact: string;
  mitigation: string;
}
interface Findings {
  health: 'green' | 'amber' | 'red';
  headline: string;
  summary: string;
  highlights: string[];
  risks: Risk[];
  blockers: string[];
  next_steps: string[];
}
interface StatusReportDetail {
  id: string;
  title: string;
  org_label: string;
  project_label: string;
  period_label: string;
  period_start: string;
  period_end: string;
  health?: string;
  status: string;
  html_snapshot?: string;
  findings: Findings;
  inputs: any;
  created_at: string;
}

export default function StatusReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [report, setReport] = useState<StatusReportDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api(`/status-reports/${id}`)
      .then((d: StatusReportDetail) => {
        setReport(d);
        setLoading(false);
      })
      .catch((e: any) => {
        toast.error(e.message ?? 'Rapor yüklenemedi');
        setLoading(false);
      });
  }, [id]);

  function handlePrint() {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      iframe.contentWindow.print();
    } else {
      window.print();
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Rapor yükleniyor…
      </div>
    );
  }

  if (!report) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-muted-foreground">Rapor bulunamadı.</p>
        <Button className="mt-4" onClick={() => router.push('/status-reports')} variant="outline">
          <ArrowLeft className="size-4" /> Geri
        </Button>
      </div>
    );
  }

  const findings = report.findings ?? ({} as Findings);
  const health = report.health ?? findings.health;
  const risks = Array.isArray(findings.risks) ? findings.risks : [];

  return (
    <div>
      <PageHeader
        title={report.org_label}
        subtitle={`${report.period_label} · ${report.project_label}`}
        actions={
          <div className="flex items-center gap-2">
            {health && (
              <Badge variant={HEALTH_VARIANT[health] ?? 'neutral'}>
                Genel Durum: {HEALTH_LABEL[health] ?? health}
              </Badge>
            )}
            <Badge variant="neutral"><ClipboardCheck className="size-3" />Durum Raporu</Badge>
          </div>
        }
      />

      {/* Action bar */}
      <div className="mb-5 flex flex-wrap gap-3">
        <Button onClick={() => router.push('/status-reports')} variant="outline" size="sm">
          <ArrowLeft className="size-4" /> Raporlar
        </Button>
        <Button onClick={handlePrint} variant="outline" size="sm">
          <Printer className="size-4" /> Yazdır / PDF'e Aktar
        </Button>
      </div>

      {/* Branded HTML preview (primary view) */}
      <Card className="mb-6 overflow-hidden">
        {report.html_snapshot ? (
          <iframe
            ref={iframeRef}
            srcDoc={report.html_snapshot}
            className="w-full border-none h-[80vh]"
            title={report.title}
            sandbox="allow-same-origin allow-scripts allow-modals"
          />
        ) : (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">
            Bu rapor için HTML görüntüsü yok.
          </div>
        )}
      </Card>

      {/* Structured risks table */}
      {risks.length > 0 && (
        <Card className="overflow-hidden">
          <div className="border-b border-border px-5 py-3">
            <h3 className="text-sm font-semibold">Riskler</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3">Risk</th>
                <th className="px-5 py-3">Önem</th>
                <th className="px-5 py-3">Olasılık</th>
                <th className="px-5 py-3">Etki</th>
                <th className="px-5 py-3">Azaltma</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="px-5 py-3 font-medium text-foreground">{r.title}</td>
                  <td className="px-5 py-3">
                    <Badge variant={SEVERITY_VARIANT[r.severity] ?? 'neutral'}>
                      {SEVERITY_LABEL[r.severity] ?? r.severity}
                    </Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    {SEVERITY_LABEL[r.likelihood] ?? r.likelihood}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{r.impact}</td>
                  <td className="px-5 py-3 text-muted-foreground">{r.mitigation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
