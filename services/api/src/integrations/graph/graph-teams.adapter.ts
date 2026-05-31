import { Logger } from '@nestjs/common';
import type { IntegrationKind, ToolName } from '@dynops/shared';
import type { ConnectorAdapter, ConnectionInfo, ExecResult } from '../contracts';
import { graphFetch, getGraphToken } from './graph-client';

// Real Teams connector via Microsoft Graph (app-only).
// - pollChannelMessages() → /teams/{team}/channels/{channel}/messages  (needs ChannelMessage.Read.All)
// - execute(send_teams_message) → POST .../messages   (app-only posting is restricted by Microsoft;
//   may return 403 unless RSC/migration is configured — surfaced as a normal failed result).
export class GraphTeamsAdapter implements ConnectorAdapter {
  readonly kind: IntegrationKind = 'teams';
  private readonly logger = new Logger('Graph:teams');

  private ids(conn: ConnectionInfo): { team: string; channel: string } {
    const team = conn.config.team_id as string;
    const channel = conn.config.channel_id as string;
    if (!team || !channel) throw new Error(`integration "${conn.name}" needs config.team_id and config.channel_id`);
    return { team, channel };
  }

  async healthCheck(conn: ConnectionInfo) {
    const started = Date.now();
    try {
      await getGraphToken();
      const { team, channel } = this.ids(conn);
      const c = await graphFetch(`/teams/${team}/channels/${channel}?$select=displayName`);
      return { ok: true, latencyMs: Date.now() - started, detail: `Graph OK — channel ${c.displayName}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, detail: (e as Error).message };
    }
  }

  async execute(tool: ToolName, args: Record<string, unknown>, conn: ConnectionInfo): Promise<ExecResult> {
    if (tool !== 'send_teams_message') return { ok: false, detail: `GraphTeamsAdapter cannot execute ${tool}` };
    const { team, channel } = this.ids(conn);
    try {
      const res = await graphFetch(`/teams/${team}/channels/${channel}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: { contentType: 'html', content: (args.body as string) ?? (args.content as string) ?? '' } }),
      });
      return { ok: true, external_id: res?.id ?? `graph-teams-${Date.now()}`, detail: 'Posted to Teams channel' };
    } catch (e) {
      // app-only posting often requires RSC; report as failure rather than throwing
      return { ok: false, detail: `Teams post failed (app-only posting may require RSC): ${(e as Error).message}` };
    }
  }

  // Poll channel messages newer than `since` (ISO). Returns messages + new watermark.
  async pollChannelMessages(conn: ConnectionInfo): Promise<{ messages: TeamsMsg[]; since: string }> {
    const { team, channel } = this.ids(conn);
    const since = (conn.config.last_sync as string) || '1970-01-01T00:00:00Z';
    const page = await graphFetch(`/teams/${team}/channels/${channel}/messages?$top=20`);
    const out: TeamsMsg[] = [];
    let newest = since;
    for (const m of page.value ?? []) {
      const created = m.createdDateTime as string;
      if (created && created > since && m.messageType === 'message') {
        out.push({
          id: m.id,
          from: m.from?.user?.displayName ?? m.from?.application?.displayName ?? 'unknown',
          text: (m.body?.content ?? '').replace(/<[^>]+>/g, '').trim(),
          createdDateTime: created,
        });
      }
      if (created && created > newest) newest = created;
    }
    return { messages: out, since: newest };
  }
}

export interface TeamsMsg {
  id: string;
  from: string;
  text: string;
  createdDateTime: string;
}

export interface ChannelRef { teamId: string; teamName: string; channelId: string; channelName: string }

// Discover the channels of every team a user belongs to.
// Needs Team.ReadBasic.All (joinedTeams + channel list). Throws on 403 if missing.
export async function discoverUserChannels(userUpn: string, maxChannels = 12): Promise<ChannelRef[]> {
  const teams = await graphFetch(`/users/${encodeURIComponent(userUpn)}/joinedTeams?$select=id,displayName`);
  const refs: ChannelRef[] = [];
  for (const t of teams.value ?? []) {
    if (refs.length >= maxChannels) break;
    try {
      const chans = await graphFetch(`/teams/${t.id}/channels?$select=id,displayName`);
      for (const c of chans.value ?? []) {
        refs.push({ teamId: t.id, teamName: t.displayName, channelId: c.id, channelName: c.displayName });
        if (refs.length >= maxChannels) break;
      }
    } catch {
      /* skip teams we can't read channels for */
    }
  }
  return refs;
}

// The newest real messages (with content) in a channel — newest first, capped.
// Channel activity is sparse, so we take the latest regardless of date window
// (`_sinceISO` kept for signature compatibility but not hard-filtered).
export async function fetchChannelMessagesSince(ref: ChannelRef, _sinceISO: string, cap = 20): Promise<TeamsMsg[]> {
  const page = await graphFetch(`/teams/${ref.teamId}/channels/${ref.channelId}/messages?$top=${Math.min(Math.max(cap, 20), 50)}`);
  const out: TeamsMsg[] = [];
  for (const m of page.value ?? []) {
    if (m.messageType !== 'message') continue;
    const text = (m.body?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) out.push({ id: m.id, from: m.from?.user?.displayName ?? ref.teamName, text, createdDateTime: m.createdDateTime });
  }
  out.sort((a, b) => (b.createdDateTime ?? '').localeCompare(a.createdDateTime ?? ''));
  return out.slice(0, cap);
}
