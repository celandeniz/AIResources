// Customer-deliverable document renderer: converts the AI-generated markdown
// (senior-consultant training doc) into a print-ready standalone HTML page —
// styled cover, TOC-friendly headings, tables, mermaid process diagrams,
// screenshot placeholders. Mirrors the status-html.ts approach.

// Text-node escaping. NEVER use this inside an attribute — it leaves quotes
// intact; use attrEsc() there instead.
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Attribute-context escaping: additionally neutralises both quote styles so a
// value can never terminate the attribute and inject a new one (e.g. onerror=).
// Every `attr="${...}"` interpolation carrying model-generated text MUST use it.
function attrEsc(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function inline(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Compact markdown→HTML: headings, tables, lists, mermaid fences, paragraphs.
export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  let inMermaid = false;
  let mermaidBuf: string[] = [];
  let listOpen: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listOpen) { out.push(`</${listOpen}>`); listOpen = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (!inMermaid && /```\s*mermaid/i.test(line)) { inMermaid = true; mermaidBuf = []; i++; continue; }
      if (inMermaid) { out.push(`<div class="mermaid">${esc(mermaidBuf.join('\n'))}</div>`); inMermaid = false; i++; continue; }
      // generic code fence
      closeList();
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); i++; continue;
    }
    if (inMermaid) { mermaidBuf.push(line); i++; continue; }

    // tables: consecutive lines starting with |
    if (line.trim().startsWith('|')) {
      closeList();
      const rows: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const parsed = rows
        .filter((r) => !/^\|[\s:|-]+\|$/.test(r)) // separator row
        .map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      if (parsed.length) {
        const [head, ...body] = parsed;
        out.push('<table><thead><tr>' + head.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
          body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      }
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-•*]\s+(.*)$/);
    if (ol || ul) {
      const kind = ol ? 'ol' : 'ul';
      if (listOpen !== kind) { closeList(); out.push(`<${kind}>`); listOpen = kind; }
      out.push(`<li>${inline((ol ?? ul)![1])}</li>`); i++; continue;
    }

    if (!line.trim()) { closeList(); i++; continue; }
    // embedded images (live screenshots as data URIs). The URL is validated
    // (data:image/* or https: only) AND attribute-escaped — model-generated
    // markdown is untrusted input.
    const img = line.trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
    if (img) {
      closeList();
      const url = img[2];
      const schemeOk = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ||
        (() => { try { return new URL(url).protocol === 'https:'; } catch { return false; } })();
      if (schemeOk) {
        // BOTH attributes are attribute-escaped: the alt text is free-form
        // model output and a bare `"` there would otherwise close the attribute
        // and let an `onerror=` handler through.
        out.push(`<figure class="screenshot"><img src="${attrEsc(url)}" alt="${attrEsc(img[1])}"/></figure>`);
      } else {
        out.push(`<div class="shot">${esc(img[1] || 'görsel')}</div>`); // reddedilen URL → yer tutucu
      }
      i++; continue;
    }
    // screenshot placeholder callout
    if (/^📷|\[Ekran görüntüsü/i.test(line.trim())) {
      closeList();
      out.push(`<div class="shot">${inline(line.trim().replace(/^📷\s*/, ''))}</div>`); i++; continue;
    }
    closeList();
    out.push(`<p>${inline(line.trim())}</p>`); i++;
  }
  closeList();
  return out.join('\n');
}

export function renderDocHtml(opts: {
  title: string;
  subtitle?: string;
  customer?: string;
  project?: string;
  adoRef?: string;
  markdown: string;
  generatedAt: string;
  // Per-response CSP nonce. The page renders untrusted model output, so the
  // caller serves it with a nonce-based script-src (no 'unsafe-inline') and
  // every script below carries this nonce.
  nonce: string;
}): string {
  const body = markdownToHtml(opts.markdown);
  const n = attrEsc(opts.nonce);
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"/>
<title>${esc(opts.title)}</title>
<script nonce="${n}" src="https://cdn.jsdelivr.net/npm/mermaid@10.9.4/dist/mermaid.min.js" integrity="sha384-fGOpyux4znQZ+n4tUrYReB2Ulu6K1MtBxIkbHauU09YM1hvCyA5oX9JUc1hRkDEr" crossorigin="anonymous"></script>
<script nonce="${n}">window.addEventListener('DOMContentLoaded',()=>{try{mermaid.initialize({startOnLoad:true,theme:'neutral'});}catch(e){}
var b=document.getElementById('printBtn');if(b)b.addEventListener('click',function(){window.print();});});</script>
<style>
  :root{--ink:#16233b;--accent:#1f4e8c;--muted:#5b6b84;--line:#d8dfeb}
  *{box-sizing:border-box} body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);margin:0;background:#fff}
  .page{max-width:840px;margin:0 auto;padding:48px 56px}
  .cover{border-bottom:3px solid var(--accent);padding-bottom:28px;margin-bottom:32px}
  .cover .brand{font-size:30px;font-weight:800;letter-spacing:.5px;color:var(--accent)}
  .cover .doctype{color:var(--muted);margin-top:6px}
  .cover h1{font-size:22px;margin:14px 0 4px;color:var(--accent)}
  .cover .meta{color:var(--muted);font-size:13px;margin-top:10px}
  h1{font-size:20px;color:var(--accent);margin:34px 0 10px}
  h2{font-size:17px;color:var(--accent);margin:28px 0 8px}
  h3{font-size:15px;color:var(--ink);margin:20px 0 6px}
  p,li{font-size:14px;line-height:1.65}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13.5px}
  th{background:var(--accent);color:#fff;text-align:left;padding:8px 10px}
  td{border:1px solid var(--line);padding:7px 10px;vertical-align:top}
  tr:nth-child(even) td{background:#f6f8fc}
  .mermaid{margin:18px 0;text-align:center;background:#fafbfe;border:1px solid var(--line);border-radius:8px;padding:14px}
  .shot{border:1.5px dashed var(--accent);border-radius:8px;padding:14px;margin:14px 0;color:var(--muted);background:#f4f7fd;font-size:13px}
  figure.screenshot{margin:14px 0;text-align:center}
  figure.screenshot img{max-width:100%;border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 10px rgba(22,35,59,.08)}
  .shot:before{content:"📷 ";}
  pre{background:#0f1830;color:#dce6f7;border-radius:8px;padding:14px;font-size:12.5px;overflow-x:auto}
  code{background:#eef2f9;border-radius:4px;padding:1px 5px;font-size:.92em}
  pre code{background:none;padding:0}
  .footer{margin-top:44px;border-top:1px solid var(--line);padding-top:12px;color:var(--muted);font-size:12px;text-align:center}
  @media print{.page{padding:24px 8mm}.no-print{display:none}h1,h2{break-after:avoid}table,.mermaid,.shot{break-inside:avoid}}
  .printbar{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:8px 0;text-align:right}
  .printbar button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:13px;cursor:pointer}
</style></head>
<body><div class="page">
  <div class="printbar no-print"><button id="printBtn" type="button">🖨 Yazdır / PDF</button></div>
  <div class="cover">
    <div class="brand">DYNAMICSOPS</div>
    <div class="doctype">${esc(opts.customer ?? '')} — Eğitim / Süreç Dokümanı</div>
    <h1>${esc(opts.title)}</h1>
    ${opts.subtitle ? `<div>${esc(opts.subtitle)}</div>` : ''}
    <div class="meta">${[opts.project && `Proje: ${opts.project}`, opts.adoRef && `İş kalemi: ${opts.adoRef}`, `Tarih: ${new Date(opts.generatedAt).toLocaleDateString('tr-TR')}`].filter(Boolean).map((x) => esc(String(x))).join(' • ')}</div>
  </div>
  ${body}
  <div class="footer">— Doküman sonu — ${esc(opts.customer ?? '')} • Hazırlayan: DynamicsOps (AI destekli, danışman onaylı) • ${new Date(opts.generatedAt).toLocaleDateString('tr-TR')} —</div>
</div></body></html>`;
}
