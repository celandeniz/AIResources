import { Logger } from '@nestjs/common';
import { jsonrepair } from 'jsonrepair';
import type { AgentRunRequest } from '@dynops/shared';
import { currentWorkspaceId } from '../../common/tenant';
import type { CosmosTask } from '../../integrations/cosmos/timelog.service';
import type { ProjectMail } from './mail-gather';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const logger = new Logger('StatusReports:synthesize');

// ─────────────────────────────────────────────────────────────────────────────
// AI structured output for a project status report.
// ─────────────────────────────────────────────────────────────────────────────
export interface Risk {
  title: string;
  severity: 'low' | 'medium' | 'high';
  likelihood: 'low' | 'medium' | 'high';
  impact: string;
  mitigation: string;
}

export interface Findings {
  health: 'green' | 'amber' | 'red';
  headline: string;
  summary: string;
  highlights: string[];
  risks: Risk[];
  blockers: string[];
  next_steps: string[];
}

export interface DevopsSummary {
  total: number;
  byState: Record<string, number>;
  byType: Record<string, number>;
  sumEstimate: number;
  sumCompleted: number;
  activeInPeriod: number;
}

interface AiResourceLike {
  key: string;
  name: string;
  system_prompt: string;
  llm_provider: string;
  llm_model: string;
  temperature: any;
  allowed_tools: unknown;
  confidence_threshold: any;
}

// The report JSON schema the draft.content must carry.
const REPORT_SCHEMA =
  '{"health":"green|amber|red","headline":string,"summary":string (2-4 cümle),' +
  '"highlights":string[] (3-6),"risks":[{"title":string,"severity":"low|medium|high",' +
  '"likelihood":"low|medium|high","impact":string,"mitigation":string}] (2-6),' +
  '"blockers":string[],"next_steps":string[] (3-6)}';

// System prompt OVERRIDE: replaces the resource's persona (e.g. the PM's
// meeting-notes persona) so the model authors a project status report and
// places the structured report (as minified JSON) in the AgentResult draft.content.
const STATUS_AUTHOR_SYSTEM =
  'Sen kıdemli bir teslimat/proje yöneticisisin ve bir danışmanlık firması için PROJE DURUM RAPORU yazıyorsun. ' +
  'Sana yalnızca Azure DevOps iş öğeleri ve Outlook e-posta özeti verilecek; SADECE bu verilere dayan. ' +
  'Çıktın bir AgentResult JSON nesnesi olacak. "draft" alanını şu şekilde doldur: draft.kind="document", ' +
  'draft.content = TEK SATIR MINIFIED JSON (markdown YOK, çitleme YOK, başka metin YOK) ve tam olarak şu şemada: ' +
  REPORT_SCHEMA + '. ' +
  'Riskleri ve sağlık durumunu (yeşil/sarı/kırmızı) verilerden çıkar; somut ol ve gerçek iş öğelerine atıf yap. ' +
  'Tüm metinleri TÜRKÇE yaz. confidence alanını 0.7 yap. tool_intents boş olsun. ' +
  'Toplantı notu, aksiyon tablosu veya başka bir format ÜRETME — yalnızca yukarıdaki rapor şemasını draft.content içine koy.';

const BODY_INSTRUCTION =
  'GÖREV: Yukarıdaki verilere dayanarak proje durum raporunu üret. ' +
  'draft.content alanına SADECE şu şemada minified JSON koy: ' + REPORT_SCHEMA + '. Türkçe yaz.';

async function runAgent(req: AgentRunRequest): Promise<any> {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

function buildContext(input: {
  orgLabel: string;
  projectLabel: string;
  periodLabel: string;
  devopsSummary: DevopsSummary | null;
  devopsNotable: CosmosTask[];
  mailDigest: ProjectMail[];
}): string {
  const lines: string[] = [];
  lines.push(`PROJE: ${input.projectLabel}`);
  lines.push(`MÜŞTERİ/ORGANİZASYON: ${input.orgLabel}`);
  lines.push(`DÖNEM: ${input.periodLabel}`);
  lines.push('');

  // DevOps summary
  if (input.devopsSummary) {
    const s = input.devopsSummary;
    lines.push('=== AZURE DEVOPS ÖZETİ ===');
    lines.push(`Toplam iş öğesi: ${s.total}`);
    lines.push(`Dönem içinde aktif (değişen): ${s.activeInPeriod}`);
    lines.push(
      `Duruma göre: ${Object.entries(s.byState).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    );
    lines.push(
      `Türe göre: ${Object.entries(s.byType).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    );
    lines.push(`Toplam orijinal tahmin: ${s.sumEstimate} sa · Tamamlanan iş: ${s.sumCompleted} sa`);
    lines.push('');
    if (input.devopsNotable.length) {
      lines.push('Öne çıkan iş öğeleri:');
      for (const t of input.devopsNotable) {
        lines.push(
          `[#${t.workItemId}] (${t.state ?? '?'}, ${t.assignee ?? 'atanmamış'}, P${t.priority ?? '?'}) ${t.title} — tahmin ${t.originalEstimate}/tamamlanan ${t.completedWork}`,
        );
      }
      lines.push('');
    }
  } else {
    lines.push('=== AZURE DEVOPS ===');
    lines.push('(Bu kaynak seçilmedi veya veri yok.)');
    lines.push('');
  }

  // Outlook digest
  lines.push('=== OUTLOOK E-POSTA ÖZETİ ===');
  if (input.mailDigest.length) {
    for (const m of input.mailDigest.slice(0, 25)) {
      const date = (m.at || '').slice(0, 10);
      lines.push(`${date} | ${m.from} | ${m.subject} — ${m.preview}`);
    }
  } else {
    lines.push('(İlgili e-posta bulunamadı veya bu kaynak seçilmedi.)');
  }
  lines.push('');

  lines.push('=== GÖREV ===');
  lines.push(BODY_INSTRUCTION);

  return lines.join('\n');
}

function parseFindings(raw: string | null | undefined, fallbackHeadline: string): Findings {
  const text = (raw ?? '').trim();
  // Strip ```json fences and any leading/trailing prose around the JSON object.
  let candidate = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) candidate = candidate.slice(first, last + 1);

  // The LLM hand-writes the report JSON inside draft.content, which occasionally
  // has minor syntax glitches (stray quotes, trailing commas, bare newlines).
  // Try strict parse first, then a repaired parse before giving up.
  const tryParse = (s: string): any => {
    try { return JSON.parse(s); } catch { /* fall through */ }
    try { return JSON.parse(jsonrepair(s)); } catch { return null; }
  };

  {
    const parsed = tryParse(candidate);
    if (!parsed) {
      logger.warn('synthesizeStatus: agent output was not valid JSON (even after repair) — using fallback Findings');
      return {
        health: 'amber',
        headline: fallbackHeadline,
        summary: text || 'Otomatik özet üretilemedi',
        highlights: [],
        risks: [],
        blockers: [],
        next_steps: [],
      };
    }
    const health = ['green', 'amber', 'red'].includes(parsed.health) ? parsed.health : 'amber';
    return {
      health,
      headline: String(parsed.headline ?? fallbackHeadline),
      summary: String(parsed.summary ?? ''),
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
      risks: Array.isArray(parsed.risks)
        ? parsed.risks.map((r: any) => ({
            title: String(r?.title ?? ''),
            severity: ['low', 'medium', 'high'].includes(r?.severity) ? r.severity : 'medium',
            likelihood: ['low', 'medium', 'high'].includes(r?.likelihood) ? r.likelihood : 'medium',
            impact: String(r?.impact ?? ''),
            mitigation: String(r?.mitigation ?? ''),
          }))
        : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String) : [],
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// synthesizeStatus — calls ai_project_manager to write the narrative + risks.
// ─────────────────────────────────────────────────────────────────────────────
export async function synthesizeStatus(input: {
  resource: AiResourceLike;
  orgLabel: string;
  projectLabel: string;
  periodLabel: string;
  devopsSummary: DevopsSummary | null;
  devopsNotable: CosmosTask[];
  mailDigest: ProjectMail[];
}): Promise<Findings> {
  const body = buildContext({
    orgLabel: input.orgLabel,
    projectLabel: input.projectLabel,
    periodLabel: input.periodLabel,
    devopsSummary: input.devopsSummary,
    devopsNotable: input.devopsNotable,
    mailDigest: input.mailDigest,
  });

  const req: AgentRunRequest = {
    run_id: `status-report-${Date.now()}`,
    workspace_id: currentWorkspaceId() ?? undefined,
    ai_resource: {
      // Use a NON-registered key so the agent routes to the neutral "generic"
      // graph (deliverable → draft.content) instead of the project_manager graph,
      // whose extract_actions node forces a meeting-notes / action-item format.
      // We keep ai_project_manager's provider/model/temperature for LLM routing.
      key: 'ai_status_reporter',
      name: 'AI Status Reporter',
      system_prompt: STATUS_AUTHOR_SYSTEM,
      provider: input.resource.llm_provider,
      model: input.resource.llm_model,
      temperature: Number(input.resource.temperature),
      tools: [],
      confidence_threshold: Number(input.resource.confidence_threshold),
    },
    activity: {
      id: `status-report-${Date.now()}`,
      channel: 'manual',
      subject: `Proje Durum Raporu — ${input.projectLabel}`,
      body,
      priority: 'normal',
      customer: null,
    },
    context: { thread: [], rag_hints: [], rag_hits: [] },
    options: { max_tool_intents: 0 },
  };

  let resp: any;
  try {
    resp = await runAgent(req);
  } catch (e) {
    logger.error(`synthesizeStatus: agent call failed: ${(e as Error).message}`);
    return {
      health: 'amber',
      headline: input.projectLabel,
      summary: 'Otomatik özet üretilemedi',
      highlights: [],
      risks: [],
      blockers: [],
      next_steps: [],
    };
  }

  return parseFindings(resp?.draft?.content, input.projectLabel);
}
