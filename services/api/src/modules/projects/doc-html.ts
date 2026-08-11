// Customer-deliverable document renderer: converts the AI-generated markdown
// (senior-consultant training doc) into a print-ready standalone HTML page —
// styled cover, TOC-friendly headings, tables, mermaid process diagrams,
// screenshot placeholders and Paged.js-backed PDF pagination. Mirrors the
// status-html.ts approach and treats every model-produced value as untrusted.

// Text-node escaping. NEVER use this inside an attribute — it leaves quotes
// intact; use attrEsc() there instead.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Attribute-context escaping: additionally neutralises both quote styles so a
// value can never terminate the attribute and inject a new one (e.g. onerror=).
// Every attribute interpolation carrying model-generated text MUST use it.
function attrEsc(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function plainHeadingText(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[\*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Turkish-aware, ASCII-only anchor base for generated h2/h3 headings. */
export function slugifyHeading(text: string): string {
  const slug = plainHeadingText(text)
    .replace(/[ıİ]/g, 'i')
    .replace(/[şŞ]/g, 's')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'bolum';
}

// Short alias kept for focused renderer tests and future section tooling.
export const slugify = slugifyHeading;

export interface DocHeading {
  level: 2 | 3;
  text: string;
  id: string;
}

export interface MarkdownRenderResult {
  html: string;
  headings: DocHeading[];
}

type CalloutType = 'dikkat' | 'ipucu' | 'uyari';

const CALLOUT_TITLES: Record<CalloutType, string> = {
  dikkat: 'Dikkat',
  ipucu: 'İpucu',
  uyari: 'Sistem uyarısı',
};

function normaliseCalloutType(raw: string): CalloutType | null {
  const value = raw
    .replace(/[ıİ]/g, 'i')
    .replace(/[şŞ]/g, 's')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u')
    .replace(/[öÖ]/g, 'o')
    .replace(/[çÇ]/g, 'c')
    .toLowerCase();
  if (value === 'dikkat' || value === 'note' || value === 'important') return 'dikkat';
  if (value === 'ipucu' || value === 'tip') return 'ipucu';
  if (value === 'uyari' || value === 'warning' || value === 'caution') return 'uyari';
  return null;
}

function calloutBodyHtml(lines: string[]): string {
  const out: string[] = [];
  let listOpen: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    const ul = line.match(/^[-•*]\s+(.*)$/);
    if (ol || ul) {
      const kind: 'ul' | 'ol' = ol ? 'ol' : 'ul';
      if (listOpen !== kind) {
        closeList();
        out.push(`<${kind}>`);
        listOpen = kind;
      }
      out.push(`<li>${inline((ol ?? ul)![1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function renderCallout(type: CalloutType, lines: string[]): string {
  const content = calloutBodyHtml(lines);
  return `<div class="callout callout-${type}" role="note"><span class="callout-title">${CALLOUT_TITLES[type]}</span>${content}</div>`;
}

function figureCaption(raw: string, index: number): string {
  let caption = raw.trim().replace(/^📷\s*/u, '');
  const placeholder = caption.match(/^\[?Ekran görüntüsü\s*:\s*(.*?)\]?$/i);
  if (placeholder) caption = placeholder[1].trim();
  caption = caption
    .replace(/^(?:Ekran|Şekil)\s+\d+\s*[—–-]\s*/i, '')
    .replace(/^\[|\]$/g, '')
    .trim();
  return `Ekran ${index} — ${caption || 'Görsel'}`;
}

function isAllowedImageUrl(url: string): boolean {
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Compact markdown→HTML with heading metadata for the TOC. Only the deliberately
 * supported markdown subset is emitted and raw HTML is always escaped.
 */
export function markdownToHtmlWithHeadings(md: string): MarkdownRenderResult {
  const lines = md.split('\n');
  const out: string[] = [];
  const headings: DocHeading[] = [];
  const slugCounts = new Map<string, number>();
  let i = 0;
  let inMermaid = false;
  let mermaidBuf: string[] = [];
  let listOpen: 'ul' | 'ol' | null = null;
  let figureIndex = 0;

  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`);
      listOpen = null;
    }
  };

  const nextHeadingId = (text: string): string => {
    const base = slugifyHeading(text);
    const count = (slugCounts.get(base) ?? 0) + 1;
    slugCounts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };

  const renderPlaceholder = (label: string) => {
    figureIndex++;
    const caption = figureCaption(label, figureIndex);
    out.push(`<figure class="shot"><div class="shot-placeholder">${inline(label || 'görsel')}</div><figcaption>${esc(caption)}</figcaption></figure>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (!inMermaid && /```\s*mermaid/i.test(line)) {
        closeList();
        inMermaid = true;
        mermaidBuf = [];
        i++;
        continue;
      }
      if (inMermaid) {
        out.push(`<div class="mermaid">${esc(mermaidBuf.join('\n'))}</div>`);
        inMermaid = false;
        i++;
        continue;
      }
      // Generic code fence.
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      if (i < lines.length) i++;
      continue;
    }
    if (inMermaid) {
      mermaidBuf.push(line);
      i++;
      continue;
    }

    // Fenced callouts: :::dikkat / :::ipucu / :::uyari ... :::
    const calloutStart = line.trim().match(/^:::\s*([^\s]+)\s*(.*)$/i);
    const calloutType = calloutStart ? normaliseCalloutType(calloutStart[1]) : null;
    if (calloutStart && calloutType) {
      closeList();
      const sameLine = calloutStart[2].match(/^(.*?)\s+:::\s*$/);
      if (sameLine) {
        out.push(renderCallout(calloutType, sameLine[1] ? [sameLine[1]] : []));
        i++;
        continue;
      }
      const content: string[] = calloutStart[2] ? [calloutStart[2]] : [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i].trim())) {
        content.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push(renderCallout(calloutType, content));
      continue;
    }

    // GitHub/Obsidian-style tolerant aliases, including the visible fallback
    // stub emitted when a document section exhausts its model ladder.
    const alert = line.trim().match(/^>\s*\[!([^\]]+)\]\s*(.*)$/i);
    const alertType = alert ? normaliseCalloutType(alert[1]) : null;
    if (alert && alertType) {
      closeList();
      const content: string[] = alert[2] ? [alert[2]] : [];
      i++;
      while (i < lines.length) {
        const continuation = lines[i].match(/^\s*>\s?(.*)$/);
        if (!continuation) break;
        content.push(continuation[1]);
        i++;
      }
      out.push(renderCallout(alertType, content));
      continue;
    }

    // Tables: consecutive lines starting with |.
    if (line.trim().startsWith('|')) {
      closeList();
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(lines[i].trim());
        i++;
      }
      const parsed = rows
        .filter((row) => !/^\|[\s:|-]+\|$/.test(row))
        .map((row) => row.replace(/^\||\|$/g, '').split('|').map((cell) => inline(cell.trim())));
      if (parsed.length) {
        const [head, ...body] = parsed;
        out.push('<table><thead><tr>' + head.map((cell) => `<th>${cell}</th>`).join('') + '</tr></thead><tbody>' +
          body.map((row) => '<tr>' + row.map((cell) => `<td>${cell}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      }
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      if (level === 2 || level === 3) {
        const text = plainHeadingText(heading[2]);
        const id = nextHeadingId(text);
        headings.push({ level, text, id });
        out.push(`<h${level} id="${attrEsc(id)}">${inline(heading[2])}</h${level}>`);
      } else {
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      }
      i++;
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-•*]\s+(.*)$/);
    if (ol || ul) {
      const kind: 'ul' | 'ol' = ol ? 'ol' : 'ul';
      if (listOpen !== kind) {
        closeList();
        out.push(`<${kind}>`);
        listOpen = kind;
      }
      out.push(`<li>${inline((ol ?? ul)![1])}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // Embedded screenshots (data URIs) and remote HTTPS images. Both URL and
    // alt attributes remain subject to the original whitelist + attr escaping.
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (image) {
      closeList();
      figureIndex++;
      const caption = figureCaption(image[1], figureIndex);
      if (isAllowedImageUrl(image[2])) {
        out.push(`<figure class="screenshot"><img src="${attrEsc(image[2])}" alt="${attrEsc(image[1])}"/><figcaption>${esc(caption)}</figcaption></figure>`);
      } else {
        out.push(`<figure class="shot"><div class="shot-placeholder">${inline(image[1] || 'görsel')}</div><figcaption>${esc(caption)}</figcaption></figure>`);
      }
      i++;
      continue;
    }

    // Screenshot placeholder emitted by the model when no live capture exists.
    if (/^📷|^\[Ekran görüntüsü/i.test(line.trim())) {
      closeList();
      renderPlaceholder(line.trim().replace(/^📷\s*/u, ''));
      i++;
      continue;
    }

    closeList();
    out.push(`<p>${inline(line.trim())}</p>`);
    i++;
  }

  if (inMermaid) out.push(`<div class="mermaid">${esc(mermaidBuf.join('\n'))}</div>`);
  closeList();
  return { html: out.join('\n'), headings };
}

// Backwards-compatible pure helper used by existing callers/tests.
export function markdownToHtml(md: string): string {
  return markdownToHtmlWithHeadings(md).html;
}

export interface DocRenderMeta {
  hedef_kitle?: string | null;
  moduller?: string | string[] | null;
  ortam?: string | string[] | null;
  ornek_kayit?: string | null;
  surum?: string | null;
  hazirlayan?: string | string[] | null;
}

function metaValue(value: unknown, fallback = '—'): string {
  const rendered = Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean).join(', ')
    : String(value ?? '').trim();
  return rendered || fallback;
}

function renderCoverMeta(meta?: DocRenderMeta): string {
  const rows: Array<[string, string]> = [
    ['Hedef kitle', metaValue(meta?.hedef_kitle, 'Son kullanıcı')],
    ['Modüller', metaValue(meta?.moduller)],
    ['Ortam', metaValue(meta?.ortam)],
    ['Örnek kayıt', metaValue(meta?.ornek_kayit)],
    ['Sürüm', metaValue(meta?.surum, '1.0')],
    ['Hazırlayan', metaValue(meta?.hazirlayan, 'DynamicsOps')],
  ];
  return `<table class="cover-meta" aria-label="Doküman bilgileri"><tbody>${rows
    .map(([label, value]) => `<tr><th scope="row">${esc(label)}</th><td>${esc(value)}</td></tr>`)
    .join('')}</tbody></table>`;
}

export function renderTableOfContents(headings: DocHeading[]): string {
  const items = headings.map((heading) =>
    `<li class="toc-level-${heading.level}"><a href="#${attrEsc(heading.id)}" data-target-id="${attrEsc(heading.id)}"><span class="toc-text">${esc(heading.text)}</span><span class="toc-leader" aria-hidden="true"></span><span class="toc-page-number" aria-label="Sayfa numarası"></span></a></li>`).join('');
  const content = items || '<li class="toc-empty">Başlık bulunamadı</li>';
  return `<nav class="toc" aria-label="İçindekiler"><h2>İçindekiler</h2><ol>${content}</ol></nav>`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('tr-TR');
}

// Paged.js is pinned; the integrity hash below is the SHA-384 of the exact
// jsdelivr bytes for pagedjs@0.4.3 (hashed from the CDN response, not the npm
// tarball). Re-hash if the pinned version ever changes.
const PAGED_JS_URL = 'https://cdn.jsdelivr.net/npm/pagedjs@0.4.3/dist/paged.polyfill.min.js';

export function renderDocHtml(opts: {
  title: string;
  subtitle?: string;
  customer?: string;
  project?: string;
  adoRef?: string;
  markdown: string;
  generatedAt: string;
  meta?: DocRenderMeta;
  mode?: 'screen' | 'pdf';
  // Per-response CSP nonce. The page renders untrusted model output, so the
  // caller serves it with a nonce-based script-src (no 'unsafe-inline') and
  // every script below carries this nonce.
  nonce: string;
}): string {
  const rendered = markdownToHtmlWithHeadings(opts.markdown);
  const toc = renderTableOfContents(rendered.headings);
  // Runtime normalisation keeps this attribute safe even if a JavaScript
  // caller bypasses the TypeScript union.
  const mode: 'screen' | 'pdf' = opts.mode === 'pdf' ? 'pdf' : 'screen';
  const isPdf = mode === 'pdf';
  const n = attrEsc(opts.nonce);
  const pdfCsp = isPdf
    ? `<meta http-equiv="Content-Security-Policy" content="${attrEsc(`default-src 'self'; img-src 'self' data: https:; script-src https://cdn.jsdelivr.net https://viewer.diagrams.net 'nonce-${opts.nonce}'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'`)}"/>`
    : '';
  const pagedBootstrap = isPdf ? `<script nonce="${n}">window.__docReady=false;window.__pagedAfterPromise=new Promise(function(resolve){window.__resolvePagedAfter=resolve;});window.PagedConfig={auto:false,after:function(flow){window.__pagedFlow=flow;if(window.__resolvePagedAfter)window.__resolvePagedAfter(flow);}};</script>
<script nonce="${n}" src="${PAGED_JS_URL}" integrity="sha384-y6+mefdjvGUaOPOrIMXHgP6Wwpza9G0N1QW1YUteLiwb50olbeI7H909UwZTMuVX" crossorigin="anonymous"></script>` : '';

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
${pdfCsp}<title>${esc(opts.title)}</title>
<script nonce="${n}" src="https://cdn.jsdelivr.net/npm/mermaid@10.9.4/dist/mermaid.min.js" integrity="sha384-fGOpyux4znQZ+n4tUrYReB2Ulu6K1MtBxIkbHauU09YM1hvCyA5oX9JUc1hRkDEr" crossorigin="anonymous"></script>
${pagedBootstrap}
<script nonce="${n}">(function(){
  function fontsReady(){try{return document.fonts&&document.fonts.ready?Promise.resolve(document.fonts.ready).catch(function(){}):Promise.resolve();}catch(e){return Promise.resolve();}}
  function mermaidReady(){var nodes=document.querySelectorAll('.mermaid');if(!nodes.length||!window.mermaid)return Promise.resolve();try{mermaid.initialize({startOnLoad:false,theme:'neutral'});return Promise.resolve(mermaid.run({nodes:Array.prototype.slice.call(nodes)})).catch(function(){});}catch(e){return Promise.resolve();}}
  function decorateToc(){var pages=Array.prototype.slice.call(document.querySelectorAll('.pagedjs_page'));if(!pages.length)return;var pageById={};pages.forEach(function(page,index){Array.prototype.forEach.call(page.querySelectorAll('[id]'),function(node){if(node.id&&!pageById[node.id])pageById[node.id]=String(page.getAttribute('data-page-number')||index+1);});});Array.prototype.forEach.call(document.querySelectorAll('.toc a[data-target-id]'),function(link){var number=pageById[link.getAttribute('data-target-id')||''];var target=link.querySelector('.toc-page-number');if(number&&target)target.textContent=number;});document.body.classList.add('paged-ready');}
  function runPaged(){if(!${isPdf ? 'true' : 'false'}||!window.PagedPolyfill||typeof window.PagedPolyfill.preview!=='function')return Promise.resolve();return new Promise(function(resolve){var settled=false;var finish=function(){if(settled)return;settled=true;clearTimeout(timer);decorateToc();resolve();};var timer=setTimeout(finish,30000);if(window.__pagedAfterPromise)window.__pagedAfterPromise.then(finish).catch(finish);try{Promise.resolve(window.PagedPolyfill.preview()).then(function(){setTimeout(finish,0);}).catch(finish);}catch(e){finish();}});}
  function start(){var button=document.getElementById('printBtn');if(button)button.addEventListener('click',function(){window.print();});Promise.all([fontsReady(),mermaidReady()]).then(runPaged).catch(function(){}).then(function(){window.__docReady=true;});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();</script>
<style>
  :root{--ink:#16233b;--accent:#1f4e8c;--muted:#5b6b84;--line:#d8dfeb;--attention:#c67a13;--warning:#b42318;--tip:#16794b}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);margin:0;background:#fff}
  .page{max-width:840px;margin:0 auto;padding:48px 56px}
  .cover{border-bottom:3px solid var(--accent);padding-bottom:28px;margin-bottom:32px;break-after:page;page-break-after:always}
  .cover .brand{font-size:30px;font-weight:800;letter-spacing:.5px;color:var(--accent)}
  .cover .doctype{color:var(--muted);margin-top:6px}
  .cover h1{font-size:22px;margin:14px 0 4px;color:var(--accent)}
  .cover-meta{max-width:620px;margin:24px 0 0;font-size:13px}
  .cover-meta th{width:34%;background:#eef3fa;color:var(--ink);border:1px solid var(--line);font-weight:700;padding:7px 10px}
  .cover-meta td{background:#fff;border:1px solid var(--line);padding:7px 10px}
  .cover-meta tr:nth-child(even) td{background:#f8fafe}
  .toc{padding-top:8px}
  .mode-pdf .toc{break-after:page;page-break-after:always;min-height:70vh}
  .toc h2{font-size:20px;margin-top:0}
  .toc ol{list-style:none;padding:0;margin:18px 0}
  .toc li{margin:0}
  .toc li.toc-level-3{padding-left:22px}
  .toc a{display:flex;align-items:baseline;gap:8px;color:var(--ink);text-decoration:none;padding:5px 0;font-size:13.5px}
  .toc a:hover .toc-text{color:var(--accent);text-decoration:underline}
  .toc-level-2 .toc-text{font-weight:700}
  .toc-leader{flex:1;border-bottom:1px dotted #a8b3c5;min-width:20px;transform:translateY(-3px)}
  .toc-page-number{display:none;min-width:22px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
  .mode-pdf .toc-page-number{display:inline;visibility:hidden}.mode-pdf.paged-ready .toc-page-number{visibility:visible}
  .toc-empty{color:var(--muted);font-style:italic;font-size:13px}
  h1{font-size:20px;color:var(--accent);margin:34px 0 10px}
  h2{font-size:17px;color:var(--accent);margin:28px 0 8px;scroll-margin-top:58px}
  h3{font-size:15px;color:var(--ink);margin:20px 0 6px;scroll-margin-top:58px}
  p,li{font-size:14px;line-height:1.65}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.5px}
  th{background:var(--accent);color:#fff;text-align:left;padding:8px 10px}
  td{border:1px solid var(--line);padding:7px 10px;vertical-align:top}
  tr:nth-child(even) td{background:#f6f8fc}
  .mermaid{margin:18px 0;text-align:center;background:#fafbfe;border:1px solid var(--line);border-radius:8px;padding:14px}
  figure{margin:14px 0;break-inside:avoid;page-break-inside:avoid}
  figure.screenshot{text-align:center}
  figure.screenshot img{display:block;max-width:100%;height:auto;margin:0 auto;border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 10px rgba(22,35,59,.08)}
  figcaption{margin-top:7px;color:var(--muted);font-size:12px;font-style:italic;text-align:center}
  figure.shot{border:1.5px dashed var(--accent);border-radius:8px;padding:14px;color:var(--muted);background:#f4f7fd;font-size:13px}
  .shot-placeholder:before{content:"📷 ";}
  .callout{margin:14px 0;padding:12px 14px;border-left:4px solid var(--accent);border-radius:0 7px 7px 0;background:#eef4fc;break-inside:avoid;page-break-inside:avoid}
  .callout-title{display:block;font-size:13px;font-weight:800;margin-bottom:5px;color:var(--accent)}
  .callout p{margin:4px 0;font-size:13.5px}.callout ul,.callout ol{margin:5px 0;padding-left:22px}
  .callout-dikkat{border-left-color:var(--attention);background:#fff8e8}.callout-dikkat .callout-title{color:#8a5207}
  .callout-ipucu{border-left-color:var(--tip);background:#edf9f3}.callout-ipucu .callout-title{color:var(--tip)}
  .callout-uyari{border-left-color:var(--warning);background:#fff1f0}.callout-uyari .callout-title{color:var(--warning)}
  pre{background:#0f1830;color:#dce6f7;border-radius:8px;padding:14px;font-size:12.5px;overflow-x:auto}
  code{background:#eef2f9;border-radius:4px;padding:1px 5px;font-size:.92em}
  pre code{background:none;padding:0}
  table,.callout,figure{break-inside:avoid;page-break-inside:avoid}
  h1,h2,h3{break-after:avoid;page-break-after:avoid}
  .footer{margin-top:44px;border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:12px;text-align:center}
  .printbar{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:8px 0;text-align:right;z-index:2}
  .printbar button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:13px;cursor:pointer}
  .mode-pdf .page{max-width:none;margin:0;padding:0}
  @page{size:A4;margin:18mm 12mm 16mm}
  @media print{.page{max-width:none;margin:0;padding:0}.no-print{display:none}.cover,.toc{break-after:page;page-break-after:always}.toc{min-height:70vh}table,.mermaid,.callout,figure{break-inside:avoid;page-break-inside:avoid}}
</style></head>
<body class="mode-${mode}"><div class="page">
  ${isPdf ? '' : '<div class="printbar no-print"><button id="printBtn" type="button">🖨 Yazdır / PDF</button></div>'}
  <div class="cover">
    <div class="brand">DYNAMICSOPS</div>
    <div class="doctype">${esc(opts.customer ?? '')} — Eğitim / Süreç Dokümanı</div>
    <h1>${esc(opts.title)}</h1>
    ${opts.subtitle ? `<div>${esc(opts.subtitle)}</div>` : ''}
    ${renderCoverMeta(opts.meta)}
  </div>
  ${toc}
  ${rendered.html}
  <div class="footer">— Doküman sonu — ${esc(opts.customer ?? '')} • Hazırlayan: ${esc(metaValue(opts.meta?.hazirlayan, 'DynamicsOps'))} • ${esc(formatDate(opts.generatedAt))} —</div>
</div></body></html>`;
}
