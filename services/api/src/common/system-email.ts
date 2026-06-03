// ─────────────────────────────────────────────────────────────────────────────
// System-generated email detection.
//
// Recognises auto-generated / machine mail (no-reply senders, RFC auto headers,
// bounce & out-of-office notices, newsletters & monitoring alerts) so the
// platform can SKIP drafting a reply to them. Used at ingestion time.
//
// Detection is intentionally heuristic and conservative-but-broad: each signal
// returns a short human-readable reason for the audit trail / UI badge.
// ─────────────────────────────────────────────────────────────────────────────

export interface SystemEmailInput {
  from?: string | null;
  subject?: string | null;
  body?: string | null;
  // Lowercased header name → value, when available (Graph internetMessageHeaders).
  headers?: Record<string, string> | null;
}

export interface SystemEmailVerdict {
  system: boolean;
  reason?: string;
}

// 1) Sender localpart / address patterns for automated mailboxes.
const SENDER_PATTERNS = [
  /no[._-]?reply@/i,
  /do[._-]?not[._-]?reply@/i,
  /donotreply@/i,
  /mailer[-_]?daemon@/i,
  /postmaster@/i,
  /^bounce[s]?[@.+-]/i,
  /(^|[._-])automated@/i,
  /(^|[._-])notifications?@/i,
  /(^|[._-])alerts?@/i,
  /(^|[._-])newsletter@/i,
  /(^|[._-])news@/i,
  /(^|[._-])no-reply[._-]/i,
];

// 2) Subject patterns for bounces / auto-replies / receipts.
const SUBJECT_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /^\s*undeliverable\b/i, reason: 'Bounce: undeliverable' },
  { re: /delivery (has )?failed|delivery status notification|returned mail|mail delivery (failed|subsystem)/i, reason: 'Bounce: delivery failure' },
  { re: /^\s*automatic reply\b|^\s*auto(matic)?[- ]?reply\b/i, reason: 'Automatic reply' },
  { re: /out of (the )?office|otomatik yanıt|ofis dışı/i, reason: 'Out-of-office reply' },
  { re: /read receipt|okundu bilgisi|delivery receipt/i, reason: 'Read/delivery receipt' },
  { re: /^\s*(accepted|declined|tentative):/i, reason: 'Calendar response' },
];

// 3) Newsletter / monitoring / CI alert hints (sender domain or subject).
const ALERT_HINTS: { re: RegExp; reason: string }[] = [
  { re: /github\.com|\[github\]|github actions|workflow run/i, reason: 'CI/GitHub notification' },
  { re: /azure-noreply|azure monitor|azure devops|azure alert|pipeline (failed|succeeded)/i, reason: 'Azure/DevOps notification' },
  { re: /datadog|pagerduty|sentry|grafana|new relic|monitor(ing)? alert/i, reason: 'Monitoring alert' },
  { re: /atlassian|jira|confluence|slack\b/i, reason: 'SaaS notification' },
];

function checkHeaders(headers: Record<string, string>): string | null {
  const get = (k: string) => headers[k.toLowerCase()] ?? '';
  const autoSub = get('auto-submitted').toLowerCase();
  if (autoSub && autoSub !== 'no') return `Auto-Submitted: ${autoSub}`;
  if (get('x-auto-response-suppress')) return 'X-Auto-Response-Suppress header';
  const prec = get('precedence').toLowerCase();
  if (/(bulk|auto_reply|list|junk)/.test(prec)) return `Precedence: ${prec}`;
  if (get('list-unsubscribe') || get('list-id')) return 'Mailing-list headers (List-Unsubscribe/List-Id)';
  if (get('x-autoreply') || get('x-autorespond')) return 'X-Autoreply header';
  if (/(generated|automated)/i.test(get('x-mailer'))) return 'Automated X-Mailer';
  return null;
}

export function detectSystemEmail(input: SystemEmailInput): SystemEmailVerdict {
  const from = (input.from ?? '').trim();
  const subject = (input.subject ?? '').trim();
  const body = (input.body ?? '').trim();

  // 1) Headers (most reliable when present)
  if (input.headers) {
    const h = checkHeaders(input.headers);
    if (h) return { system: true, reason: h };
  }

  // 2) Sender address
  for (const re of SENDER_PATTERNS) {
    if (re.test(from)) return { system: true, reason: `Automated sender (${from})` };
  }

  // 3) Subject
  for (const { re, reason } of SUBJECT_PATTERNS) {
    if (re.test(subject)) return { system: true, reason };
  }

  // 4) Newsletter / alert hints (sender + subject + body footer)
  const haystack = `${from}\n${subject}\n${body}`;
  for (const { re, reason } of ALERT_HINTS) {
    if (re.test(haystack)) return { system: true, reason };
  }
  // Generic newsletter footer
  if (/unsubscribe|abonelikten çık|manage (your )?preferences|view (this email )?in (your )?browser/i.test(body)) {
    return { system: true, reason: 'Newsletter (unsubscribe footer)' };
  }

  return { system: false };
}
