import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import type { AgentRunRequest } from '@dynops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId, tenantStore } from '../../common/tenant';
import { GraphEmailAdapter } from '../../integrations/graph/graph-email.adapter';
import { graphConfigured } from '../../integrations/graph/graph-client';
import { htmlToText, extractOwnReply, extractKeywords, topicFromSubject } from './style.util';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

const DISTILL_SYSTEM =
  'Sen bir yazı-stili analistisin. Sana bir kişinin geçmişte gönderdiği gerçek yanıt örnekleri verilecek. ' +
  'Bu kişinin YANIT STİLİNİ çıkar ve gelecekteki yanıtların aynı sesle yazılabilmesi için kısa, uygulanabilir bir ' +
  'STİL REHBERİ yaz. Şunları kapsa: genel ton (resmi/samimi), selamlama ve kapanış kalıpları, tipik uzunluk, ' +
  'dil kullanımı (Türkçe/İngilizce karışımı), cümle yapısı, sık kullanılan ifadeler, yapılması ve kaçınılması ' +
  'gerekenler. Madde işaretleri kullan, en fazla ~200 kelime. Çıktıyı yalnızca draft.content alanına düz metin ' +
  'olarak yaz (JSON veya başlık ekleme).';

@Controller('style')
class StyleController {
  private readonly email = new GraphEmailAdapter();
  constructor(private readonly prisma: PrismaService) {}

  // ── GET /style/status ──────────────────────────────────────────────────────
  @Get('status')
  async status() {
    const wsId = currentWorkspaceId();
    const [profile, byChannel] = await Promise.all([
      (this.prisma as any).style_profiles.findFirst({ where: { ...(wsId ? { workspace_id: wsId } : {}), channel: 'all' } }),
      (this.prisma as any).style_examples.groupBy({ by: ['channel'], _count: { _all: true }, where: wsId ? { workspace_id: wsId } : {} }),
    ]);
    const counts: Record<string, number> = {};
    for (const r of byChannel as any[]) counts[r.channel] = r._count._all;
    return {
      profile: profile ? { text: profile.profile_text, sample_count: profile.sample_count, sources: profile.sources, updated_at: profile.updated_at } : null,
      examples: counts,
      graph_configured: graphConfigured(),
    };
  }

  // ── GET /style/examples ──────────────────────────────────────────────────────
  @Get('examples')
  examples(@Query('channel') channel?: string, @Query('limit') limit?: string) {
    const wsId = currentWorkspaceId();
    return (this.prisma as any).style_examples.findMany({
      where: { ...(wsId ? { workspace_id: wsId } : {}), ...(channel ? { channel } : {}) },
      orderBy: { sent_at: 'desc' },
      take: Math.min(Number(limit) || 30, 100),
      select: { id: true, channel: true, subject: true, topic: true, reply_text: true, sent_at: true },
    });
  }

  // ── POST /style/learn ──────────────────────────────────────────────────────
  @Roles('manager')
  @Post('learn')
  async learn(
    @Body() body: { sources?: { email?: boolean; teams?: boolean; devops?: boolean }; months?: number },
    @CurrentUser() _user: AuthUser,
  ) {
    return this.runLearn(currentWorkspaceId() ?? null, body);
  }

  // ── POST /style/relearn (scheduled internal job) ───────────────────────────
  // Called by the worker on a weekly cadence (x-internal-token → admin). Runs
  // the default workspace with all sources; tenant context is set explicitly
  // since internal calls carry no workspace.
  @Roles('manager')
  @Post('relearn')
  async relearn() {
    const ws = '00000000-0000-0000-0000-0000000000ff';
    return tenantStore.run({ workspaceId: ws }, () =>
      this.runLearn(ws, { sources: { email: true, teams: true, devops: true }, months: 12 }),
    );
  }

  private async runLearn(
    wsId: string | null,
    body: { sources?: { email?: boolean; teams?: boolean; devops?: boolean }; months?: number },
  ) {
    const sources = { email: body?.sources?.email !== false, teams: !!body?.sources?.teams, devops: !!body?.sources?.devops };
    const months = Math.min(Math.max(Number(body?.months) || 12, 1), 36);
    const sinceISO = new Date(Date.now() - months * 30 * 24 * 3600 * 1000).toISOString();
    const result: any = { email: { learned: 0 }, teams: { learned: 0, note: '' }, devops: { learned: 0, note: '' } };

    // ── Email (LIVE via Graph sent items) ──────────────────────────────────────
    if (sources.email) {
      if (!graphConfigured()) {
        result.email.note = 'Graph yapılandırılmadı — e-posta stili öğrenilemedi.';
      } else {
        const gm =
          (await this.prisma.integrations.findFirst({ where: { type: 'graph_email', is_mock: false } })) ??
          (await this.prisma.integrations.findFirst({ where: { type: 'graph_email' } }));
        const mailbox = (gm?.config as any)?.mailbox ?? 'deniz@dynamicsops.com';
        const conn = { id: gm?.id ?? 'style', type: 'graph_email', name: gm?.name ?? 'style', config: (gm?.config as any) ?? { mailbox }, isMock: false };
        try {
          const sent = await this.email.fetchSentItems(conn as any, mailbox, sinceISO, 200);
          for (const m of sent) {
            const text = extractOwnReply(htmlToText(m.body ?? m.bodyPreview ?? ''));
            if (!text || text.length < 25) continue; // skip empties / one-liners with no signal
            const subject = m.subject ?? '';
            await (this.prisma as any).style_examples.upsert({
              where: { workspace_id_channel_external_id: { workspace_id: wsId ?? null, channel: 'email', external_id: m.internetMessageId ?? m.id } },
              update: {},
              create: {
                workspace_id: wsId ?? undefined,
                channel: 'email',
                external_id: m.internetMessageId ?? m.id,
                subject: subject.slice(0, 500),
                topic: topicFromSubject(subject),
                keywords: extractKeywords(subject, text) as any,
                reply_text: text.slice(0, 4000),
                sent_at: m.sentDateTime ? new Date(m.sentDateTime) : null,
              },
            });
            result.email.learned++;
          }
          result.email.mailbox = mailbox;
        } catch (e) {
          result.email.note = `Graph hata: ${(e as Error).message}`;
        }
      }
    }

    // ── Teams (not connected — graceful) ───────────────────────────────────────
    if (sources.teams) {
      result.teams.note = 'Teams kanal geçmişine erişim yok (Graph admin onayı + kanal eşlemesi gerekli). Bağlanınca otomatik dahil edilecek.';
    }
    // ── Azure DevOps comments (not connected — graceful) ───────────────────────
    if (sources.devops) {
      result.devops.note = 'ADO yorum geçmişi erişimi yok (ADO yorum API bağlantısı gerekli). Bağlanınca otomatik dahil edilecek.';
    }

    // ── Distill a style profile from the harvested examples ─────────────────────
    const examples = await (this.prisma as any).style_examples.findMany({
      where: { ...(wsId ? { workspace_id: wsId } : {}) },
      orderBy: { sent_at: 'desc' },
      take: 40,
      select: { subject: true, reply_text: true },
    });
    if (examples.length > 0) {
      const corpus = examples
        .map((e: any, i: number) => `--- Örnek ${i + 1} (Konu: ${e.subject ?? ''}) ---\n${String(e.reply_text).slice(0, 600)}`)
        .join('\n\n');
      const profileText = await this.distill(corpus, wsId ?? null);
      if (profileText) {
        await (this.prisma as any).style_profiles.upsert({
          where: { workspace_id_channel: { workspace_id: wsId ?? null, channel: 'all' } },
          update: { profile_text: profileText, sample_count: examples.length, sources: sources as any },
          create: { workspace_id: wsId ?? undefined, channel: 'all', profile_text: profileText, sample_count: examples.length, sources: sources as any },
        });
        result.profile_updated = true;
        result.profile_preview = profileText.slice(0, 300);
      }
    } else {
      result.profile_updated = false;
      result.note = 'Öğrenilecek örnek bulunamadı.';
    }

    return result;
  }

  // Call the agent (generic graph via a non-registered key) to distill the profile.
  private async distill(corpus: string, wsId: string | null): Promise<string | null> {
    const req: AgentRunRequest = {
      run_id: `style-distill-${Date.now()}`,
      workspace_id: wsId ?? undefined,
      ai_resource: {
        key: 'ai_style_analyst', // non-registered → neutral generic graph
        name: 'AI Style Analyst',
        system_prompt: DISTILL_SYSTEM,
        provider: 'ollama',
        model: 'qwen3',
        temperature: 0.2,
        tools: [],
        confidence_threshold: 0.5,
      },
      activity: {
        id: `style-distill-${Date.now()}`,
        channel: 'manual',
        subject: 'Yanıt stili analizi',
        body: `Aşağıda bu kişinin geçmiş yanıt örnekleri var. Stil rehberini çıkar.\n\n${corpus}`,
        priority: 'normal',
        customer: null,
      },
      context: { thread: [], rag_hints: [], rag_hits: [] },
      options: { max_tool_intents: 0 },
    };
    try {
      const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify(req),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      return String(data?.draft?.content ?? '').trim() || null;
    } catch {
      return null;
    }
  }
}

@Module({ controllers: [StyleController] })
export class StyleModule {}
