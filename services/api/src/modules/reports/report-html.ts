import type { ReportData } from './report-builder';

// ─────────────────────────────────────────────────────────────────────────────
// DynamicsOps brand colours
// ─────────────────────────────────────────────────────────────────────────────
const NAVY = '#1f2d3d';
const BLUE = '#2f6fed';
const BLUE_LIGHT = '#e8f0fe';
const BORDER = '#d1d9e0';
const TEXT = '#1a2533';
const MUTED = '#6b7a8d';
const WHITE = '#ffffff';

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

// ─────────────────────────────────────────────────────────────────────────────
export function renderReportHtml(report: ReportData): string {
  const today = new Date().toLocaleDateString('tr-TR', { year: 'numeric', month: 'long', day: 'numeric' });

  // ── Header ──────────────────────────────────────────────────────────────
  const header = `
  <header style="display:flex;align-items:center;justify-content:space-between;padding:18px 32px 16px;background:${WHITE};border-bottom:3px solid ${BLUE};">
    <div>
      <span style="font-size:26px;font-weight:900;color:${NAVY};letter-spacing:-.5px;">Dynamics</span><span style="font-size:26px;font-weight:900;color:${BLUE};">Ops</span>
    </div>
    <div style="text-align:right;">
      <div style="font-size:19px;font-weight:700;color:${NAVY};">${esc(report.orgLabel)}</div>
      ${report.projectLabel ? `<div style="font-size:13px;color:${MUTED};margin-top:2px;">${esc(report.projectLabel)}</div>` : ''}
      <div style="font-size:12px;color:${MUTED};margin-top:2px;">${esc(report.periodLabel)}</div>
    </div>
  </header>
  <div style="background:${BLUE_LIGHT};padding:8px 32px;font-size:12px;color:${NAVY};">
    <strong>Özet</strong> &nbsp;·&nbsp; Hazırlayan: DynamicsOps &nbsp;·&nbsp; ${today}
    &nbsp;&nbsp;|&nbsp;&nbsp; <strong>İş Öğesi Eforu:</strong> ${fmt(report.grand.workItemEffort)} sa
    &nbsp;|&nbsp; <strong>Timer Süresi:</strong> ${fmt(report.grand.hours)} sa
    &nbsp;|&nbsp; <strong>Kayıt:</strong> ${report.grand.recordCount}
  </div>`;

  // ── Project totals table ─────────────────────────────────────────────────
  const projTable = `
  ${sectionHeading('Proje Bazında Toplamlar')}
  <table style="${tableStyle()}">
    <thead><tr>
      <th style="${thStyle('left')}">Proje</th>
      <th style="${thStyle('right')}">Toplam Saat</th>
      <th style="${thStyle('right')}">Kayıt Sayısı</th>
      <th style="${thStyle('right')}">Pay %</th>
    </tr></thead>
    <tbody>
      ${report.projectTotals.map((r) => `
      <tr>
        <td style="${tdStyle()}">${esc(r.project)}</td>
        <td style="${tdStyle('right')}">${fmt(r.hours)}</td>
        <td style="${tdStyle('right')}">${r.recordCount}</td>
        <td style="${tdStyle('right')}">${r.sharePct}%</td>
      </tr>`).join('')}
      <tr style="background:${BLUE_LIGHT};">
        <td style="${tdStyle('left', true)}">GENEL TOPLAM</td>
        <td style="${tdStyle('right', true)}">${fmt(report.grand.hours)}</td>
        <td style="${tdStyle('right', true)}">${report.grand.recordCount}</td>
        <td style="${tdStyle('right', true)}">100%</td>
      </tr>
    </tbody>
  </table>`;

  // ── User×Project matrix ──────────────────────────────────────────────────
  const { users, projects, matrix, userTotals } = report.userByProject;
  const matrixTable = `
  ${sectionHeading('Kişi Bazında Dağılım (Proje × Kullanıcı)')}
  <table style="${tableStyle()}">
    <thead><tr>
      <th style="${thStyle('left')}">Kişi</th>
      ${projects.map((p) => `<th style="${thStyle('right')}">${esc(p)}</th>`).join('')}
      <th style="${thStyle('right')}">Toplam</th>
    </tr></thead>
    <tbody>
      ${users.map((u) => `
      <tr>
        <td style="${tdStyle()}">${esc(u)}</td>
        ${projects.map((p) => `<td style="${tdStyle('right')}">${fmt(matrix[u]?.[p] ?? 0)}</td>`).join('')}
        <td style="${tdStyle('right', true)}">${fmt(userTotals[u] ?? 0)}</td>
      </tr>`).join('')}
      <tr style="background:${BLUE_LIGHT};">
        <td style="${tdStyle('left', true)}">TOPLAM</td>
        ${projects.map((p) => `<td style="${tdStyle('right', true)}">${fmt(report.userByProject.projectTotals[p] ?? 0)}</td>`).join('')}
        <td style="${tdStyle('right', true)}">${fmt(report.grand.hours)}</td>
      </tr>
    </tbody>
  </table>`;

  // ── Task totals table ────────────────────────────────────────────────────
  let taskSection = '';
  if (report.grouping.byTask && report.taskTotals.length > 0) {
    taskSection = `
    ${sectionHeading('Task (İş Öğesi) Bazında')}
    <p style="font-size:11px;color:${MUTED};margin:-4px 0 10px;">
      <strong>İş Öğesi Eforu</strong>: iş öğesine girilen toplam efor (ADO <em>completed_work</em>) — müşteriye iletilen efor budur.
      &nbsp;·&nbsp; <strong>Timer Süresi</strong>: dönem içindeki kronometre kayıtları toplamı (yalnızca timer ile girilen süre).
    </p>
    <table style="${tableStyle()}">
      <thead><tr>
        <th style="${thStyle('left')}">İş Öğesi #</th>
        <th style="${thStyle('left')}">Başlık</th>
        <th style="${thStyle('left')}">Proje</th>
        <th style="${thStyle('right')}">Orijinal Tahmin (s)</th>
        <th style="${thStyle('right')}">İş Öğesi Eforu (s)</th>
        <th style="${thStyle('right')}">Timer Süresi (s)</th>
        <th style="${thStyle('right')}">Fark (s)</th>
      </tr></thead>
      <tbody>
        ${report.taskTotals.map((t) => {
          const varColor = t.variance > 0 ? '#b91c1c' : t.variance < 0 ? '#15803d' : TEXT;
          return `<tr>
            <td style="${tdStyle()}">#${esc(t.workItemId)}</td>
            <td style="${tdStyle()}">${esc(t.title)}</td>
            <td style="${tdStyle()}">${esc(t.project)}</td>
            <td style="${tdStyle('right')}">${fmt(t.originalEstimate)}</td>
            <td style="${tdStyle('right', true)}">${fmt(t.workItemEffort)}</td>
            <td style="${tdStyle('right')}">${fmt(t.approvedEffort)}</td>
            <td style="padding:8px 14px;border-bottom:1px solid ${BORDER};text-align:right;color:${varColor};font-weight:600;">${t.variance > 0 ? '+' : ''}${fmt(t.variance)}</td>
          </tr>`;
        }).join('')}
        <tr style="background:${BLUE_LIGHT};">
          <td style="${tdStyle('left', true)}" colspan="3">GENEL TOPLAM</td>
          <td style="${tdStyle('right', true)}">${fmt(report.grand.originalEstimate)}</td>
          <td style="${tdStyle('right', true)}">${fmt(report.grand.workItemEffort)}</td>
          <td style="${tdStyle('right', true)}">${fmt(report.grand.hours)}</td>
          <td style="${tdStyle('right', true)}"></td>
        </tr>
      </tbody>
    </table>`;
  }

  // ── Resource totals table ────────────────────────────────────────────────
  let resourceSection = '';
  if (report.grouping.byResource && report.resourceTotals.length > 0) {
    resourceSection = `
    ${sectionHeading('Kaynak Bazında Toplam')}
    <table style="${tableStyle()}">
      <thead><tr>
        <th style="${thStyle('left')}">Kişi</th>
        <th style="${thStyle('right')}">Toplam Saat</th>
        <th style="${thStyle('right')}">Kayıt</th>
        <th style="${thStyle('right')}">Pay %</th>
      </tr></thead>
      <tbody>
        ${report.resourceTotals.map((r) => `
        <tr>
          <td style="${tdStyle()}">${esc(r.user)}</td>
          <td style="${tdStyle('right')}">${fmt(r.hours)}</td>
          <td style="${tdStyle('right')}">${r.recordCount}</td>
          <td style="${tdStyle('right')}">${r.sharePct}%</td>
        </tr>`).join('')}
        <tr style="background:${BLUE_LIGHT};">
          <td style="${tdStyle('left', true)}">GENEL TOPLAM</td>
          <td style="${tdStyle('right', true)}">${fmt(report.grand.hours)}</td>
          <td style="${tdStyle('right', true)}">${report.grand.recordCount}</td>
          <td style="${tdStyle('right', true)}">100%</td>
        </tr>
      </tbody>
    </table>`;
  }

  // ── Detail records per project ───────────────────────────────────────────
  const detailSections = report.detailsByProject.map(({ project, records }) => `
  ${sectionHeading(`Detay Kayıtlar — ${esc(project)}`)}
  <table style="${tableStyle()}">
    <thead><tr>
      <th style="${thStyle('right')}">Saat</th>
      <th style="${thStyle('left')}">Kullanıcı</th>
      <th style="${thStyle('right')}">İş Öğesi #</th>
      <th style="${thStyle('left')}">Tarih</th>
      <th style="${thStyle('left')}">Hafta</th>
      <th style="${thStyle('left')}">Tür</th>
      <th style="${thStyle('left')}">Açıklama</th>
      <th style="${thStyle('left')}">Başlık</th>
    </tr></thead>
    <tbody>
      ${records.map((r) => `
      <tr>
        <td style="${tdStyle('right')}">${fmt(r.hours)}</td>
        <td style="${tdStyle()}">${esc(r.user)}</td>
        <td style="${tdStyle('right')}">${r.workItemId ? '#' + esc(r.workItemId) : ''}</td>
        <td style="${tdStyle()}">${esc(r.date)}</td>
        <td style="${tdStyle()}">${esc(r.week)}</td>
        <td style="${tdStyle()}">${esc(r.type ?? '')}</td>
        <td style="${tdStyle()}">${esc(r.description ?? '')}</td>
        <td style="${tdStyle()}">${esc(r.title ?? '')}</td>
      </tr>`).join('')}
      <tr style="background:${BLUE_LIGHT};">
        <td style="${tdStyle('right', true)}">${fmt(records.reduce((s, r) => s + r.hours, 0))}</td>
        <td style="${tdStyle('left', true)}" colspan="7">TOPLAM — ${esc(project)}</td>
      </tr>
    </tbody>
  </table>`).join('');

  // ── Footer ───────────────────────────────────────────────────────────────
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
  <title>${esc(report.orgLabel)} — ${esc(report.periodLabel)}</title>
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
    ${projTable}
    ${matrixTable}
    ${taskSection}
    ${resourceSection}
    ${detailSections}
  </div>
  ${footer}
</body>
</html>`;
}

function esc(s: string): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
