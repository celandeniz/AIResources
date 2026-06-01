'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { BarChart3 } from 'lucide-react';

interface ReportRow { label: string; value: number; }
interface Report { report: string; columns: string[]; rows: ReportRow[]; suggestedChart: { type: string; title: string } }
interface ChartSpec { type: 'bar' | 'donut' | 'line'; title: string; }

// ── Tiny inline SVG bar chart (no external deps) ──────────────────────────────
function BarChart({ rows, title }: { rows: ReportRow[]; title: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No data.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const barH = 24;
  const gap = 6;
  const labelW = 160;
  const barMaxW = 280;
  const svgH = rows.length * (barH + gap) + 4;
  return (
    <div>
      <p className="mb-2 text-sm font-semibold">{title}</p>
      <svg width={labelW + barMaxW + 60} height={svgH} className="overflow-visible">
        {rows.map((r, i) => {
          const y = i * (barH + gap);
          const w = Math.round((r.value / max) * barMaxW);
          return (
            <g key={r.label}>
              <text x={labelW - 8} y={y + barH / 2 + 5} textAnchor="end" className="fill-muted-foreground" fontSize={11}>{r.label}</text>
              <rect x={labelW} y={y} width={w} height={barH} rx={4} className="fill-primary opacity-80" />
              <text x={labelW + w + 6} y={y + barH / 2 + 5} fontSize={11} className="fill-foreground">{r.value}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Tiny inline SVG donut chart ────────────────────────────────────────────────
const DONUT_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#34d399', '#f87171', '#a78bfa', '#fb923c'];

function DonutChart({ rows, title }: { rows: ReportRow[]; title: string }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No data.</p>;
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const cx = 80, cy = 80, r = 60, strokeW = 22;
  let offset = 0;
  const circ = 2 * Math.PI * r;
  const slices = rows.map((row, i) => {
    const pct = row.value / total;
    const dash = pct * circ;
    const slice = { row, dash, offset, color: DONUT_COLORS[i % DONUT_COLORS.length] };
    offset += dash;
    return slice;
  });
  return (
    <div className="flex items-center gap-6">
      <div>
        <p className="mb-2 text-sm font-semibold">{title}</p>
        <svg width={160} height={160} viewBox="0 0 160 160">
          {slices.map((s) => (
            <circle key={s.row.label} cx={cx} cy={cy} r={r}
              fill="none" stroke={s.color} strokeWidth={strokeW}
              strokeDasharray={`${s.dash} ${circ - s.dash}`}
              strokeDashoffset={-s.offset} transform="rotate(-90 80 80)" />
          ))}
          <text x={cx} y={cy + 5} textAnchor="middle" fontSize={14} className="fill-foreground font-semibold">{total}</text>
        </svg>
      </div>
      <div className="space-y-1">
        {slices.map((s) => (
          <div key={s.row.label} className="flex items-center gap-2 text-xs">
            <span className="inline-block size-3 rounded-sm" style={{ background: s.color }} />
            <span className="text-foreground">{s.row.label}</span>
            <span className="text-muted-foreground">({s.row.value})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chart({ rows, chart }: { rows: ReportRow[]; chart: ChartSpec }) {
  if (chart.type === 'donut') return <DonutChart rows={rows} title={chart.title} />;
  return <BarChart rows={rows} title={chart.title} />;
}

// ── Preset example questions ───────────────────────────────────────────────────
const EXAMPLES = [
  'How are activities distributed across statuses?',
  'Which resources are handling the most work?',
  'What is the approval breakdown?',
  'Show me task status distribution.',
  'How many missions do we have by status?',
  'Which resources run the most proactive automations?',
];

export default function AnalystPage() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [chart, setChart] = useState<ChartSpec | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);

  useEffect(() => {
    api('/analyst/reports').then((d: any) => setCatalog(d.keys ?? [])).catch(() => {});
  }, []);

  async function ask(q?: string) {
    const q2 = (q ?? question).trim();
    if (!q2) return;
    setQuestion(q2);
    setBusy(true);
    setAnswer(null); setReport(null); setChart(null);
    try {
      const res: any = await api('/analyst/ask', { method: 'POST', body: JSON.stringify({ question: q2 }) });
      setAnswer(res.answer ?? null);
      setReport(res.report ?? null);
      setChart(res.chart ?? null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Data Analyst"
        subtitle="Ask a business question and get a chart powered by the safe report catalog — no free-form SQL."
        actions={<Badge variant="neutral"><BarChart3 className="size-3" />Insights</Badge>}
      />

      {/* Question input */}
      <Card className="mb-6 p-5">
        <div className="flex gap-3">
          <Input
            placeholder="e.g. How are activities distributed across statuses?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
            className="flex-1"
          />
          <Button onClick={() => ask()} disabled={!question.trim() || busy}>
            <BarChart3 className="size-4" />{busy ? 'Analysing…' : 'Ask'}
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => ask(ex)}
              className="rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              {ex}
            </button>
          ))}
        </div>
      </Card>

      {/* Results */}
      {(answer || report || chart) && (
        <div className="space-y-5">
          {answer && (
            <Card className="p-5">
              <SectionTitle>Analysis</SectionTitle>
              <p className="whitespace-pre-wrap text-sm text-foreground">{answer}</p>
            </Card>
          )}

          {report && chart && (
            <Card className="p-5">
              <SectionTitle>Chart — {chart.title}</SectionTitle>
              <div className="mt-4 overflow-x-auto">
                <Chart rows={report.rows} chart={chart} />
              </div>
            </Card>
          )}

          {report && (
            <Card className="overflow-hidden">
              <div className="border-b border-border px-5 py-3">
                <SectionTitle>Data Table — <code className="font-mono text-xs">{report.report}</code></SectionTitle>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-3">Label</th>
                    <th className="px-5 py-3 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                      <td className="px-5 py-2.5">{row.label}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums">{row.value}</td>
                    </tr>
                  ))}
                  {report.rows.length === 0 && (
                    <tr><td colSpan={2} className="px-5 py-6 text-center text-muted-foreground text-xs">No rows returned.</td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}

      {/* Catalog info */}
      {catalog.length > 0 && !answer && !report && (
        <Card className="p-5 mt-4">
          <SectionTitle>Available Reports</SectionTitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {catalog.map((k) => (
              <Badge key={k} variant="neutral" className="font-mono text-xs">{k}</Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
