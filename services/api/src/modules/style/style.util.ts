// ─────────────────────────────────────────────────────────────────────────────
// Helpers for harvesting reply STYLE from past sent messages.
// ─────────────────────────────────────────────────────────────────────────────

// Strip HTML to plain text (Graph sent-item bodies are usually HTML).
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Keep only the author's own reply text — drop the quoted/forwarded thread that
// Outlook appends below it (the part that starts at "From:", "On … wrote:",
// "-----Original Message-----", ">", "________"). This isolates the user's voice.
export function extractOwnReply(text: string): string {
  if (!text) return '';
  const lines = text.split('\n');
  const cutMarkers = [
    /^\s*from:\s/i,
    /^\s*-{2,}\s*original message\s*-{2,}/i,
    /^\s*on .+ wrote:\s*$/i,
    /^\s*_{5,}/,
    /^\s*gönderen:\s/i,            // TR Outlook
    /^\s*kimden:\s/i,
    /^\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}.+(yazdı|wrote):/i,
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (cutMarkers.some((re) => re.test(lines[i]))) { cut = i; break; }
  }
  const own = lines.slice(0, cut).join('\n');
  // Drop a trailing quoted block (lines starting with ">")
  return own.replace(/(^>.*$\n?)+/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'are', 'was', 'have', 'has',
  've', 'bir', 'bu', 'şu', 'için', 'ile', 'olarak', 'merhaba', 'selam', 're', 'fw', 'fwd',
  'teşekkürler', 'teşekkür', 'iyi', 'çalışmalar', 'thanks', 'hi', 'hello', 'regards',
]);

// Cheap keyword extraction from subject/body — drives topic matching at draft time.
export function extractKeywords(subject: string, body: string, max = 8): string[] {
  const words = `${subject ?? ''} ${body ?? ''}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const freq: Record<string, number> = {};
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1;
  return Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, max)
    .map(([w]) => w);
}

// A short topic label from the subject (strip Re:/Fwd: prefixes).
export function topicFromSubject(subject?: string | null): string {
  return (subject ?? '')
    .replace(/^(\s*(re|fw|fwd|yan|ynt|ilt)\s*:\s*)+/i, '')
    .trim()
    .slice(0, 120);
}
