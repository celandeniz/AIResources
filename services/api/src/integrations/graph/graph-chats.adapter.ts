// Teams 1:1 / group chat reader — DORMANT until Microsoft protected-API approval.
//
// /users/{upn}/chats/getAllMessages is a Microsoft PROTECTED API:
//   1. The tenant must submit the protected-API request form and be approved.
//   2. The app registration needs the Chat.Read.All APPLICATION permission
//      (admin-consented).
//   3. Usage is METERED (licensing model A or B, per-message billing;
//      evaluation mode ≈ 500 messages/app/month free).
// Until all three hold, keep ENABLE_COVERAGE_CHATS unset — every call site
// gates on chatsEnabled(), so this module is code-complete but inert.

import { graphConfigured, pagedGraphFetch } from './graph-client';
import type { TeamsMsg } from './graph-teams.adapter';

export function chatsEnabled(): boolean {
  return process.env.ENABLE_COVERAGE_CHATS === 'true' && graphConfigured();
}

// All chat messages a user participates in since the watermark. chatId is
// mapped into TeamsMsg.channelId so coverage keys work identically to channels.
export async function fetchUserChatMessages(userUpn: string, sinceISO: string, cap = 200): Promise<TeamsMsg[]> {
  if (!chatsEnabled()) return [];
  const filter = encodeURIComponent(`lastModifiedDateTime gt ${sinceISO}`);
  const raw = await pagedGraphFetch(
    `/users/${encodeURIComponent(userUpn)}/chats/getAllMessages?$filter=${filter}&$top=50`,
    { cap },
  );
  const out: TeamsMsg[] = [];
  for (const m of raw) {
    if (m.messageType !== 'message') continue;
    const text = (m.body?.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push({
      id: m.id,
      from: m.from?.user?.displayName ?? 'unknown',
      fromEmail: m.from?.user?.email ?? m.from?.user?.userPrincipalName ?? undefined,
      text,
      createdDateTime: m.createdDateTime,
      channelId: m.chatId, // chat id = the coverage conversation key
    });
  }
  return out;
}
