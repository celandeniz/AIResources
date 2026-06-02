'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Input, Select } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { FileBarChart, Printer, ShoppingCart, ArrowLeft, X } from 'lucide-react';

const BC_COMPANIES = [
  'Dynamics Ops Bilgi Tek Ltd Sti',
  'Dynamics Ops',
];

const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  sent: 'warning',
  ordered: 'success',
};

interface ReportDetail {
  id: string;
  title: string;
  scope: string;
  org_label: string;
  project_label?: string;
  period_label: string;
  period_start: string;
  period_end: string;
  status: string;
  html_snapshot?: string;
  totals: any;
  line_items: any[];
  hourly_rate?: number;
  currency?: string;
  bc_order?: any;
  customer_id?: string;
  created_at: string;
}

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [report, setReport] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showBcForm, setShowBcForm] = useState(false);
  const [bcBusy, setBcBusy] = useState(false);

  // BC order form state
  const [bcCompany, setBcCompany] = useState(BC_COMPANIES[0]);
  const [bcRate, setBcRate] = useState('');
  const [bcCurrency, setBcCurrency] = useState('TRY');
  const [bcCustomer, setBcCustomer] = useState('');
  const [bcEffortBasis, setBcEffortBasis] = useState<'workitem' | 'timer'>('workitem');

  useEffect(() => {
    if (!id) return;
    api(`/reports/${id}`)
      .then((d: ReportDetail) => {
        setReport(d);
        if (d.hourly_rate) setBcRate(String(d.hourly_rate));
        if (d.currency) setBcCurrency(d.currency);
        setLoading(false);
      })
      .catch((e: any) => {
        toast.error(e.message ?? 'Failed to load report');
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

  async function createBcOrder() {
    if (!report) return;
    setBcBusy(true);
    try {
      const res: any = await api(`/reports/${report.id}/create-bc-order`, {
        method: 'POST',
        body: JSON.stringify({
          company: bcCompany,
          hourlyRate: bcRate ? Number(bcRate) : undefined,
          currency: bcCurrency || 'TRY',
          bcCustomer: bcCustomer || report.org_label,
          effortBasis: bcEffortBasis,
        }),
      });
      toast.success(`BC order approval created — check the Approval Center (approval ID: ${res.approval_id?.slice(0, 8)}…)`);
      setShowBcForm(false);
      // Refresh report
      const updated: ReportDetail = await api(`/reports/${report.id}`);
      setReport(updated);
    } catch (e: any) {
      toast.error(e.message ?? 'BC order creation failed');
    } finally {
      setBcBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Loading report…
      </div>
    );
  }

  if (!report) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-muted-foreground">Report not found.</p>
        <Button className="mt-4" onClick={() => router.push('/reports')} variant="outline">
          <ArrowLeft className="size-4" /> Back to Reports
        </Button>
      </div>
    );
  }

  // Task lines for BC order preview — quantity follows the chosen effort basis.
  const lineQty = (t: any): number => {
    const wi = Number(t.workItemEffort ?? 0);
    const timer = Number(t.approvedEffort ?? 0);
    return bcEffortBasis === 'timer' ? timer : (wi || timer);
  };
  const taskLines: any[] = (Array.isArray(report.line_items) ? report.line_items : [])
    .map((t: any) => ({ ...t, __qty: lineQty(t) }))
    .filter((t: any) => t.__qty > 0);

  return (
    <div>
      <PageHeader
        title={report.org_label}
        subtitle={`${report.period_label}${report.project_label ? ` · ${report.project_label}` : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[report.status] ?? 'neutral'} className="capitalize">
              {report.status}
            </Badge>
            <Badge variant="neutral"><FileBarChart className="size-3" />Report</Badge>
          </div>
        }
      />

      {/* Action bar */}
      <div className="mb-5 flex flex-wrap gap-3">
        <Button onClick={() => router.push('/reports')} variant="outline" size="sm">
          <ArrowLeft className="size-4" /> Reports
        </Button>
        <Button onClick={handlePrint} variant="outline" size="sm">
          <Printer className="size-4" /> Print / Export PDF
        </Button>
        {report.status !== 'ordered' && (
          <Button onClick={() => setShowBcForm((v) => !v)} size="sm">
            <ShoppingCart className="size-4" /> Create BC Order
          </Button>
        )}
        {report.bc_order && (
          <Badge variant="success" className="flex items-center gap-1.5 px-3 py-1.5 text-sm">
            <ShoppingCart className="size-3" />
            BC Order: {(report.bc_order as any).external_id ?? 'created'}
          </Badge>
        )}
      </div>

      {/* BC order form */}
      {showBcForm && (
        <Card className="mb-6 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Create Business Central Sales Order</h3>
            <button type="button" aria-label="Close" onClick={() => setShowBcForm(false)} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">BC Company</label>
              <Select value={bcCompany} onChange={(e) => setBcCompany(e.target.value)}>
                {BC_COMPANIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Hourly Rate</label>
              <Input
                type="number"
                placeholder="e.g. 150"
                value={bcRate}
                onChange={(e) => setBcRate(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Currency</label>
              <Select value={bcCurrency} onChange={(e) => setBcCurrency(e.target.value)}>
                {['TRY', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">BC Customer (optional)</label>
              <Input
                placeholder={report.org_label}
                value={bcCustomer}
                onChange={(e) => setBcCustomer(e.target.value)}
              />
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Efor Kaynağı (fatura miktarı)</label>
              <Select value={bcEffortBasis} onChange={(e) => setBcEffortBasis(e.target.value as 'workitem' | 'timer')}>
                <option value="workitem">İş Öğesi Eforu — ADO completed_work (müşteriye iletilen efor)</option>
                <option value="timer">Timer Süresi — kronometre kayıtları (dönem içi)</option>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                İş Öğesi Eforu, müşteriye gönderdiğin gerçek eforla eşleşir; Timer Süresi yalnızca kronometreyle girilen süreyi kapsar.
              </p>
            </div>
          </div>

          {/* Task lines preview */}
          {taskLines.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Order lines ({taskLines.length})</p>
              <div className="max-h-48 overflow-auto rounded-lg border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2">Work Item</th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2 text-right">Hours</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taskLines.map((t: any, i: number) => {
                      const rate = bcRate ? Number(bcRate) : 0;
                      const amount = (t.__qty ?? 0) * rate;
                      return (
                        <tr key={i} className="border-t border-border/50">
                          <td className="px-3 py-1.5 font-mono">#{t.workItemId}</td>
                          <td className="px-3 py-1.5">{t.title}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{t.__qty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {rate > 0 ? `${amount.toFixed(2)} ${bcCurrency}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {bcRate && (
                <p className="mt-2 text-right text-xs font-medium">
                  Total:{' '}
                  {taskLines.reduce((s, t) => s + (t.__qty ?? 0) * Number(bcRate), 0).toFixed(2)}{' '}
                  {bcCurrency}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-3">
            <Button onClick={createBcOrder} disabled={bcBusy || !bcCompany}>
              <ShoppingCart className="size-4" />
              {bcBusy ? 'Creating…' : 'Submit for Approval'}
            </Button>
            <Button onClick={() => setShowBcForm(false)} variant="outline">
              Cancel
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This will create a pending approval in the Approval Center. The BC order is only created after approval.
          </p>
        </Card>
      )}

      {/* Report HTML preview */}
      <Card className="overflow-hidden">
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
            No HTML snapshot available for this report.
          </div>
        )}
      </Card>
    </div>
  );
}
