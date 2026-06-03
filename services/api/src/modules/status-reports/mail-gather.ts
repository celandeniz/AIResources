import { Logger } from '@nestjs/common';
import { graphFetch, graphConfigured } from '../../integrations/graph/graph-client';

const logger = new Logger('StatusReports:mail-gather');

export interface ProjectMail {
  subject: string;
  from: string;
  at: string;
  preview: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// gatherProjectMail — read-only Outlook digest for the status report.
// Pulls messages in the timeframe via Graph, then keyword-filters client-side.
// Graceful: returns [] when Graph isn't configured or any call fails.
// ─────────────────────────────────────────────────────────────────────────────
export async function gatherProjectMail(opts: {
  mailbox: string;
  fromISO: string;
  toISO: string;
  keywords: string[];
}): Promise<ProjectMail[]> {
  if (!graphConfigured()) return [];

  const filter = encodeURIComponent(
    `receivedDateTime ge ${opts.fromISO} and receivedDateTime le ${opts.toISO}`,
  );
  let url: string | undefined =
    `/users/${encodeURIComponent(opts.mailbox)}/messages` +
    `?$filter=${filter}&$orderby=receivedDateTime%20desc&$top=50` +
    `&$select=subject,from,receivedDateTime,bodyPreview`;

  try {
    // Page via @odata.nextLink up to ~150 messages total.
    const raw: any[] = [];
    for (let guard = 0; guard < 5 && url && raw.length < 150; guard++) {
      const page = await graphFetch(url);
      for (const m of page.value ?? []) {
        raw.push(m);
        if (raw.length >= 150) break;
      }
      url = page['@odata.nextLink'];
    }

    // Keyword filter (case-insensitive, subject OR preview). Empty → keep all.
    const kws = (opts.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
    const matched = kws.length
      ? raw.filter((m) => {
          const hay = `${m.subject ?? ''}\n${m.bodyPreview ?? ''}`.toLowerCase();
          return kws.some((k) => hay.includes(k));
        })
      : raw;

    return matched.map((m) => ({
      subject: String(m.subject ?? ''),
      from: m.from?.emailAddress?.address ?? '',
      at: m.receivedDateTime ?? '',
      preview: String(m.bodyPreview ?? '').slice(0, 300),
    }));
  } catch (e) {
    logger.error(`gatherProjectMail failed: ${(e as Error).message}`);
    return [];
  }
}
