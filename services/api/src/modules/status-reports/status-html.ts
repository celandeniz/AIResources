import type { Findings } from './synthesize';

// ─────────────────────────────────────────────────────────────────────────────
// DynamicsOps brand colours (mirrors report-html.ts)
// ─────────────────────────────────────────────────────────────────────────────
const NAVY = '#1f2d3d';
const BLUE = '#2f6fed';
const BLUE_LIGHT = '#e8f0fe';
const BORDER = '#d1d9e0';
const TEXT = '#1a2533';
const MUTED = '#6b7a8d';
const WHITE = '#ffffff';

const HEALTH_COLOR: Record<string, string> = { green: '#15803d', amber: '#b45309', red: '#b91c1c' };
const HEALTH_LABEL: Record<string, string> = { green: 'YEŞİL', amber: 'SARI', red: 'KIRMIZI' };
const SEVERITY_COLOR: Record<string, string> = { high: '#b91c1c', medium: '#b45309', low: '#15803d' };
const SEVERITY_LABEL: Record<string, string> = { high: 'Yüksek', medium: 'Orta', low: 'Düşük' };

function esc(s: string): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function tableStyle(): string {
  return `width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;`;
}

function thStyle(align: 'left' | 'right' | 'center' = 'left'): string {
  return `background:${NAVY};color:${WHITE};padding:9px 14px;text-align:${align};font-size:11px;text-transform:uppercase;letter-spacing:.06em;`;
}

function tdStyle(align: 'left' | 'right' | 'center' = 'left', bold = false): string {
  return `padding:8px 14px;border-bottom:1px solid ${BORDER};text-align:${align};${bold ? 'font-weight:700;' : ''}color:${TEXT};`;
}

function sectionHeading(title: string): string {
  return `<h2 style="font-size:15px;font-weight:700;color:${NAVY};margin:28px 0 10px;border-left:4px solid ${BLUE};padding-left:10px;">${title}</h2>`;
}

function bulletList(items: string[]): string {
  if (!items.length) return `<p style="font-size:13px;color:${MUTED};margin:0 0 16px;">—</p>`;
  return `<ul style="margin:0 0 20px;padding-left:22px;font-size:13px;color:${TEXT};line-height:1.7;">
    ${items.map((i) => `<li>${esc(i)}</li>`).join('')}
  </ul>`;
}

function severityBadge(sev: string): string {
  const color = SEVERITY_COLOR[sev] ?? MUTED;
  const label = SEVERITY_LABEL[sev] ?? sev;
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${color};color:${WHITE};font-size:11px;font-weight:700;">${esc(label)}</span>`;
}

export interface StatusHtmlInput {
  orgLabel: string;
  projectLabel: string;
  periodLabel: string;
  findings: Findings;
  inputs: any; // gathered raw summary
}

// ─────────────────────────────────────────────────────────────────────────────
export function renderStatusHtml(data: StatusHtmlInput): string {
  const today = new Date().toLocaleDateString('tr-TR', { year: 'numeric', month: 'long', day: 'numeric' });
  const f = data.findings;
  const inputs = data.inputs ?? {};
  const sources = inputs.sources ?? {};
  const devops = inputs.devops ?? null;
  const outlook = inputs.outlook ?? null;
  const keywords: string[] = Array.isArray(inputs.keywords) ? inputs.keywords : [];

  const healthColor = HEALTH_COLOR[f.health] ?? HEALTH_COLOR.amber;
  const healthLabel = HEALTH_LABEL[f.health] ?? HEALTH_LABEL.amber;

  // ── Header ──────────────────────────────────────────────────────────────
  const header = `
  <header style="display:flex;align-items:center;justify-content:space-between;padding:18px 32px 16px;background:${WHITE};border-bottom:3px solid ${BLUE};">
    <div>
      <span style="font-size:26px;font-weight:900;color:${NAVY};letter-spacing:-.5px;">Dynamics</span><span style="font-size:26px;font-weight:900;color:${BLUE};">Ops</span>
    </div>
    <div style="text-align:right;">
      <div style="font-size:19px;font-weight:700;color:${NAVY};">${esc(data.orgLabel)}</div>
      <div style="font-size:13px;color:${MUTED};margin-top:2px;">${esc(data.projectLabel)}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:2px;">${esc(data.periodLabel)}</div>
    </div>
  </header>
  <div style="background:${BLUE_LIGHT};padding:10px 32px;font-size:12px;color:${NAVY};display:flex;align-items:center;justify-content:space-between;">
    <span><strong>Proje Durum Raporu</strong> &nbsp;·&nbsp; Hazırlayan: DynamicsOps &nbsp;·&nbsp; ${today}</span>
    <span style="display:inline-block;padding:5px 14px;border-radius:999px;background:${healthColor};color:${WHITE};font-size:13px;font-weight:800;">Genel Durum: ${healthLabel}</span>
  </div>`;

  // ── Executive summary ─────────────────────────────────────────────────────
  const summarySection = `
  ${sectionHeading('Yönetici Özeti')}
  <p style="font-size:15px;font-weight:700;color:${NAVY};margin:0 0 8px;">${esc(f.headline)}</p>
  <p style="font-size:13px;color:${TEXT};line-height:1.7;margin:0 0 8px;">${esc(f.summary)}</p>`;

  // ── Highlights ─────────────────────────────────────────────────────────────
  const highlightsSection = `
  ${sectionHeading('Öne Çıkanlar')}
  ${bulletList(f.highlights)}`;

  // ── Risks table ─────────────────────────────────────────────────────────────
  const risksSection = `
  ${sectionHeading('Riskler')}
  ${
    f.risks.length
      ? `<table style="${tableStyle()}">
    <thead><tr>
      <th style="${thStyle('left')}">Risk</th>
      <th style="${thStyle('center')}">Önem</th>
      <th style="${thStyle('center')}">Olasılık</th>
      <th style="${thStyle('left')}">Etki</th>
      <th style="${thStyle('left')}">Azaltma</th>
    </tr></thead>
    <tbody>
      ${f.risks
        .map(
          (r) => `<tr>
        <td style="${tdStyle('left', true)}">${esc(r.title)}</td>
        <td style="${tdStyle('center')}">${severityBadge(r.severity)}</td>
        <td style="${tdStyle('center')}">${esc(SEVERITY_LABEL[r.likelihood] ?? r.likelihood)}</td>
        <td style="${tdStyle()}">${esc(r.impact)}</td>
        <td style="${tdStyle()}">${esc(r.mitigation)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
      : `<p style="font-size:13px;color:${MUTED};margin:0 0 16px;">Belirgin risk tespit edilmedi.</p>`
  }`;

  // ── Blockers (only if non-empty) ─────────────────────────────────────────────
  const blockersSection = f.blockers.length
    ? `${sectionHeading('Engeller')}${bulletList(f.blockers)}`
    : '';

  // ── Next steps ───────────────────────────────────────────────────────────────
  const nextStepsSection = `
  ${sectionHeading('Sonraki Adımlar')}
  ${bulletList(f.next_steps)}`;

  // ── Data summary appendix ────────────────────────────────────────────────────
  const onOff = (b: any) => (b ? 'açık' : 'kapalı');
  const byStateRows = devops?.byState
    ? Object.entries(devops.byState as Record<string, number>)
        .map(([k, v]) => `${esc(k)}: ${v}`)
        .join(' &nbsp;·&nbsp; ')
    : '—';
  const teamsLine = sources.teams
    ? 'Teams: açık'
    : (inputs.teams ? 'Teams: bağlı değil (kurulum bekliyor)' : 'Teams: kapalı');

  const appendix = `
  ${sectionHeading('Veri Özeti')}
  <table style="${tableStyle()}">
    <tbody>
      <tr>
        <td style="${tdStyle('left', true)}" width="200">Dönem</td>
        <td style="${tdStyle()}">${esc(data.periodLabel)}</td>
      </tr>
      <tr>
        <td style="${tdStyle('left', true)}">Veri Kaynakları</td>
        <td style="${tdStyle()}">Azure DevOps: ${onOff(sources.devops)} &nbsp;·&nbsp; Outlook: ${onOff(sources.outlook)} &nbsp;·&nbsp; ${teamsLine}</td>
      </tr>
      <tr>
        <td style="${tdStyle('left', true)}">Anahtar Kelimeler</td>
        <td style="${tdStyle()}">${keywords.length ? keywords.map((k) => esc(k)).join(', ') : '—'}</td>
      </tr>
      <tr>
        <td style="${tdStyle('left', true)}">DevOps İstatistikleri</td>
        <td style="${tdStyle()}">${
          devops
            ? `Toplam iş öğesi: ${devops.total} &nbsp;·&nbsp; Dönem içinde aktif: ${devops.activeInPeriod}<br>Duruma göre: ${byStateRows}<br>Tahmin: ${fmt(Number(devops.sumEstimate ?? 0))} sa &nbsp;·&nbsp; Tamamlanan: ${fmt(Number(devops.sumCompleted ?? 0))} sa`
            : '—'
        }</td>
      </tr>
      <tr>
        <td style="${tdStyle('left', true)}">E-posta</td>
        <td style="${tdStyle()}">${outlook ? `${outlook.count} eşleşen mesaj (${esc(outlook.mailbox ?? '')})` : '—'}</td>
      </tr>
    </tbody>
  </table>`;

  // ── Footer ───────────────────────────────────────────────────────────────────
  const footer = `
  <footer style="margin-top:40px;padding:14px 32px;background:${NAVY};color:${WHITE};font-size:11px;display:flex;justify-content:space-between;">
    <span><strong style="color:${BLUE};">Dynamics</strong>Ops · dynamicsops.com</span>
    <span>Oluşturulma: ${today}</span>
  </footer>`;

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(data.projectLabel)} — Durum Raporu</title>
  <style>
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      header, footer { break-inside: avoid; }
      h2 { break-before: avoid; }
      table { break-inside: avoid; }
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; margin: 0; background: #f6f8fa; color: ${TEXT}; }
    .content { max-width: 1100px; margin: 0 auto; background: ${WHITE}; padding: 0 32px 32px; }
  </style>
</head>
<body>
  ${header}
  <div class="content">
    ${summarySection}
    ${highlightsSection}
    ${risksSection}
    ${blockersSection}
    ${nextStepsSection}
    ${appendix}
  </div>
  ${footer}
</body>
</html>`;
}
