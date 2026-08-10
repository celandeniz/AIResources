// Project attribution engine — maps an incoming item (ADO work item, Teams
// message, email) to a projects row via the project's cross-channel mappings.
// Resolution order: ADO org/project → Teams team/channel → customer email
// (single active project = exact; multiple = mail_keywords match; else null).
// Pure lookup over a short-lived in-process cache; safe to call on every ingest.

import type { PrismaService } from '../../prisma/prisma.service';

export interface ResolveInput {
  customer_id?: string | null;
  adoOrg?: string | null;
  adoProject?: string | null;
  teamId?: string | null;
  channelId?: string | null;
  subject?: string | null;
}

interface ProjectRow {
  id: string;
  customer_id: string;
  status: string;
  devops_org: string | null;
  devops_project: string | null;
  teams_team_id: string | null;
  teams_channel_ids: unknown;
  teams_chat_ids: unknown;
  mail_keywords: unknown;
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; wsKey: string; rows: ProjectRow[] } | null = null;

export function invalidateProjectCache() {
  cache = null;
}

async function activeProjects(prisma: PrismaService, wsKey: string): Promise<ProjectRow[]> {
  if (cache && cache.wsKey === wsKey && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await (prisma as any).projects.findMany({
    where: { status: 'active' },
    select: {
      id: true, customer_id: true, status: true,
      devops_org: true, devops_project: true,
      teams_team_id: true, teams_channel_ids: true, teams_chat_ids: true,
      mail_keywords: true,
    },
  });
  cache = { at: Date.now(), wsKey, rows };
  return rows;
}

function asList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export async function resolveProject(
  prisma: PrismaService,
  wsKey: string,
  input: ResolveInput,
): Promise<string | null> {
  let rows: ProjectRow[];
  try {
    rows = await activeProjects(prisma, wsKey);
  } catch {
    return null; // attribution is best-effort; never block ingestion
  }
  if (!rows.length) return null;

  // 1. ADO org/project mapping (strongest signal).
  if (input.adoProject) {
    const hit = rows.find(
      (p) =>
        p.devops_project &&
        p.devops_project.toLowerCase() === input.adoProject!.toLowerCase() &&
        (!p.devops_org || !input.adoOrg || p.devops_org.toLowerCase() === input.adoOrg.toLowerCase()),
    );
    if (hit) return hit.id;
  }

  // 2. Teams team/channel/chat mapping.
  if (input.channelId || input.teamId) {
    const hit = rows.find(
      (p) =>
        (input.channelId && (asList(p.teams_channel_ids).includes(input.channelId) || asList(p.teams_chat_ids).includes(input.channelId))) ||
        (input.teamId && p.teams_team_id === input.teamId),
    );
    if (hit) return hit.id;
  }

  // 3. Customer email: single active project is exact; multiple projects
  //    disambiguate via mail_keywords over the subject.
  if (input.customer_id) {
    const mine = rows.filter((p) => p.customer_id === input.customer_id);
    if (mine.length === 1) return mine[0].id;
    if (mine.length > 1 && input.subject) {
      const subject = input.subject.toLowerCase();
      const hit = mine.find((p) => asList(p.mail_keywords).some((k) => k && subject.includes(k.toLowerCase())));
      if (hit) return hit.id;
    }
  }

  return null;
}
