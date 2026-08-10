// ECC-inspired continuous learning: confidence-scored instincts distilled from
// human approval feedback, injected into future agent prompts by the worker.

import { Body, Controller, Get, Injectable, Logger, Module, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

const DISTILL_SYSTEM =
  'Sen bir kalite koçusun. Bir AI taslağı insan tarafından düzenlendi veya reddedildi. ' +
  'Bu geri bildirimden GELECEKTE uygulanacak TEK bir kısa ders çıkar. ' +
  'Yanıtı SADECE şu JSON ile ver: {"draft":{"kind":"note","subject":null,"content":"<ders cümlesi>"},' +
  '"reasoning_summary":"...","confidence":0.7,"needs_escalation":false,"escalate_to":null,' +
  '"tool_intents":[]} — content alanına şu formatta yaz: "TRIGGER: <virgülle 2-4 anahtar kelime> | LESSON: <tek cümlelik ders>".';

@Injectable()
export class InstinctsService {
  private readonly logger = new Logger('Instincts');

  constructor(private readonly prisma: PrismaService) {}

  // Outcome feedback: instincts applied on the run get confidence adjusted.
  //  approved unchanged → +0.05 (cap 0.95); edited → −0.05; rejected → −0.15
  //  (retired below 0.2).
  async feedback(agentRunId: string | null, outcome: 'approved' | 'edited' | 'rejected') {
    if (!agentRunId) return;
    try {
      const run = await this.prisma.agent_runs.findUnique({ where: { id: agentRunId }, select: { input: true } });
      const ids: string[] = ((run?.input as any)?.instincts ?? []) as string[];
      if (!ids.length) return;
      const delta = outcome === 'approved' ? 0.05 : outcome === 'edited' ? -0.05 : -0.15;
      const rows = await (this.prisma as any).instincts.findMany({ where: { id: { in: ids } } });
      for (const row of rows) {
        const conf = Math.max(0, Math.min(0.95, Number(row.confidence) + delta));
        await (this.prisma as any).instincts.update({
          where: { id: row.id },
          data: { confidence: conf, ...(conf < 0.2 ? { status: 'retired' } : {}) },
        });
      }
    } catch (e) {
      this.logger.warn(`instinct feedback failed: ${(e as Error).message}`);
    }
  }

  // Distill a new instinct from an edited/rejected draft. Fire-and-forget.
  async distill(opts: {
    workspaceId: string | null;
    resourceId: string | null;
    original: string;
    outcome: 'edited' | 'rejected';
    finalText?: string;
    note?: string;
    context?: string;
  }) {
    try {
      const body =
        `=== BAĞLAM ===\n${(opts.context ?? '').slice(0, 1500)}\n\n` +
        `=== AI TASLAĞI ===\n${opts.original.slice(0, 2000)}\n\n` +
        (opts.outcome === 'edited'
          ? `=== İNSANIN DÜZENLENMİŞ HALİ ===\n${(opts.finalText ?? '').slice(0, 2000)}\n\nİki metni karşılaştır, insanın neyi değiştirdiğinden ders çıkar.`
          : `=== RED NOTU ===\n${opts.note ?? '(not yok)'}\n\nTaslağın neden reddedildiğinden ders çıkar.`);
      const req = {
        run_id: `instinct-${Date.now()}`,
        workspace_id: opts.workspaceId ?? undefined,
        ai_resource: {
          key: 'ai_instinct_distiller', // non-registered → neutral generic graph
          name: 'AI Instinct Distiller',
          system_prompt: DISTILL_SYSTEM,
          provider: process.env.NVIDIA_API_KEY ? 'nvidia' : 'ollama',
          model: process.env.NVIDIA_API_KEY ? 'meta/llama-3.1-8b-instruct' : 'qwen3',
          temperature: 0.2,
          tools: [],
          confidence_threshold: 0.5,
        },
        activity: { id: `instinct-${Date.now()}`, channel: 'manual', subject: 'Geri bildirim analizi', body, priority: 'normal', customer: null },
        context: { thread: [], rag_hints: [], rag_hits: [] },
        options: { max_tool_intents: 0 },
      };
      const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify(req),
      });
      if (!res.ok) return;
      const data: any = await res.json();
      const content = String(data?.draft?.content ?? '');
      const m = content.match(/TRIGGER:\s*(.+?)\s*\|\s*LESSON:\s*(.+)/is);
      if (!m) return;
      const trigger = m[1].trim().slice(0, 300);
      const lesson = m[2].trim().slice(0, 1000);
      if (!trigger || !lesson) return;

      // Same trigger + resource → evidence++, else a fresh instinct at 0.5.
      const existing = await (this.prisma as any).instincts.findFirst({
        where: { workspace_id: opts.workspaceId, resource_id: opts.resourceId, trigger, status: 'active' },
      });
      if (existing) {
        await (this.prisma as any).instincts.update({
          where: { id: existing.id },
          data: { evidence_count: { increment: 1 }, confidence: Math.min(0.95, Number(existing.confidence) + 0.1), lesson },
        });
      } else {
        await (this.prisma as any).instincts.create({
          data: {
            workspace_id: opts.workspaceId,
            resource_id: opts.resourceId,
            trigger,
            lesson,
            confidence: 0.5,
            source: 'approval_feedback',
          },
        });
      }
      this.logger.log(`distilled instinct: "${lesson.slice(0, 80)}"`);
    } catch (e) {
      this.logger.warn(`instinct distillation failed: ${(e as Error).message}`);
    }
  }
}

@Controller('instincts')
export class InstinctsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('status') status?: string) {
    return (this.prisma as any).instincts.findMany({
      where: status ? { status } : {},
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }],
      take: 200,
    });
  }

  @Roles('manager')
  @Post()
  create(@Body() body: { trigger: string; lesson: string; resource_id?: string }) {
    return (this.prisma as any).instincts.create({
      data: { trigger: String(body.trigger).slice(0, 300), lesson: String(body.lesson).slice(0, 1000), resource_id: body.resource_id ?? null, source: 'manual', confidence: 0.7 },
    });
  }

  @Roles('manager')
  @Post(':id/retire')
  retire(@Param('id') id: string) {
    return (this.prisma as any).instincts.update({ where: { id }, data: { status: 'retired' } });
  }

  @Roles('manager')
  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return (this.prisma as any).instincts.update({ where: { id }, data: { status: 'active', confidence: 0.5 } });
  }
}

@Module({
  controllers: [InstinctsController],
  providers: [InstinctsService],
  exports: [InstinctsService],
})
export class InstinctsModule {}
