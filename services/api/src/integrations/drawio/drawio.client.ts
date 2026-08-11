import { Logger } from '@nestjs/common';
import type { AgentRunRequest } from '@dynops/shared';
import { currentWorkspaceId } from '../../common/tenant';

export interface DrawioResult {
  xml: string;
  source: 'sidecar' | 'nim' | 'mock';
}

const logger = new Logger('DrawioClient');
const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MX_CELL_RE = /<mxCell[^>]+(vertex|edge)/;
const WRAPPER_RE = /<\/?(?:mxfile|diagram|mxGraphModel|root)\b/i;

const MOCK_CELLS =
  '<mxCell id="2" value="Başlangıç" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="40" y="80" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="3" value="İşlem" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="220" y="80" width="140" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="4" value="Tamamlandı" style="ellipse;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
  '<mxGeometry x="420" y="80" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="5" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;html=1;" edge="1" parent="1" source="2" target="3">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>' +
  '<mxCell id="6" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;html=1;" edge="1" parent="1" source="3" target="4">' +
  '<mxGeometry relative="1" as="geometry"/></mxCell>';

const NIM_SYSTEM_PROMPT =
  'Sen draw.io mxGraph süreç diyagramları üreten bir uzmansın. AgentResult JSON şemasını döndür; ' +
  'draft.kind="note" olsun ve draft.content alanında YALNIZ <mxCell> elemanları üret; ' +
  'mxfile/mxGraphModel/root sarmalama YOK. Her mxCell sayısal id≥2 ve parent="1" içersin. ' +
  'Her vertex="1" veya edge="1" hücresi için mxGeometry zorunlu. Kod çiti, açıklama veya başka metin ekleme.';

export function wrapMxCells(inner: string): string {
  return `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${inner.trim()}</root></mxGraphModel></diagram></mxfile>`;
}

function buildPrompt(prompt: string, steps: { title: string; caption?: string }[]): string {
  const stepText = steps
    .map((step, index) => `${index + 1}. ${step.title}${step.caption ? ` — ${step.caption}` : ''}`)
    .join('\n');
  return stepText ? `${prompt.trim()}\n\nSüreç adımları:\n${stepText}`.trim() : prompt.trim();
}

function stripCodeFence(value: string): string {
  const text = value.trim();
  const fenced = text.match(/^```(?:xml)?\s*([\s\S]*?)\s*```$/i);
  return (fenced?.[1] ?? text).trim();
}

function validMxCells(value: string | null): value is string {
  return Boolean(value?.trim() && MX_CELL_RE.test(value) && !WRAPPER_RE.test(value));
}

/**
 * Read the AI SDK v6 UI-message SSE protocol without buffering an unbounded
 * response. Text/reasoning chunks and incremental JSON tool deltas are ignored;
 * only complete display_diagram inputs are authoritative, and the last one wins.
 */
async function parseUiMessageStream(res: Response): Promise<string | null> {
  if (!res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let bytesRead = 0;
  let latestXml: string | null = null;
  let streamDone = false;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      streamDone = true;
      return;
    }
    try {
      const part: any = JSON.parse(payload);
      if (
        part?.type === 'tool-input-available' &&
        part?.toolName === 'display_diagram' &&
        typeof part?.input?.xml === 'string'
      ) {
        latestXml = part.input.xml;
      }
    } catch {
      // A malformed/non-JSON SSE line is not a complete tool input; ignore it.
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_STREAM_BYTES) {
        try {
          await reader.cancel('draw.io stream exceeded 2 MiB');
        } catch {
          // The caller will fall through to the NIM route either way.
        }
        return null;
      }

      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        consumeLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (streamDone) break;
        newline = buffered.indexOf('\n');
      }
    }

    if (!streamDone) {
      buffered += decoder.decode();
      if (buffered) consumeLine(buffered);
    }
    return latestXml;
  } finally {
    reader.releaseLock();
  }
}

async function generateViaSidecar(baseUrl: string, prompt: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
        xml: '',
        previousXml: '',
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const inner = await parseUiMessageStream(res);
    return validMxCells(inner) ? inner.trim() : null;
  } catch (error) {
    logger.debug(`draw.io sidecar unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateViaNim(prompt: string, timeoutMs: number): Promise<string | null> {
  const runKey = `drawio-${Date.now().toString(36)}`;
  const request: AgentRunRequest = {
    run_id: runKey,
    workspace_id: currentWorkspaceId() ?? undefined,
    ai_resource: {
      key: 'ai_drawio_generator',
      name: 'AI Draw.io Generator',
      system_prompt: NIM_SYSTEM_PROMPT,
      provider: 'nvidia',
      model: process.env.DRAWIO_MODEL ?? 'meta/llama-3.3-70b-instruct',
      temperature: 0.1,
      tools: [],
      confidence_threshold: 0.5,
    },
    activity: {
      id: runKey,
      channel: 'manual',
      subject: 'Draw.io süreç diyagramı',
      body: prompt,
      priority: 'normal',
      customer: null,
    },
    context: { thread: [], rag_hints: [], rag_hits: [] },
    options: { max_tool_intents: 0 },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AGENT_URL.replace(/\/+$/, '')}/v1/agents/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const usage = data?.token_usage ?? {};
    if (usage.provider !== 'nvidia' || usage.stub || usage.fallback || usage.fallback_from) return null;
    const inner = stripCodeFence(String(data?.draft?.content ?? ''));
    return validMxCells(inner) ? inner : null;
  } catch (error) {
    logger.debug(`draw.io NIM fallback unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateDrawioXml(opts: {
  prompt: string;
  steps: { title: string; caption?: string }[];
  timeoutMs?: number;
}): Promise<DrawioResult | null> {
  const drawioUrl = process.env.DRAWIO_URL?.trim();
  const nvidiaKey = process.env.NVIDIA_API_KEY?.trim();
  if (!drawioUrl && !nvidiaKey) {
    return { xml: wrapMxCells(MOCK_CELLS), source: 'mock' };
  }

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1, Number(opts.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const prompt = buildPrompt(opts.prompt, opts.steps);

  if (drawioUrl) {
    const inner = await generateViaSidecar(drawioUrl, prompt, timeoutMs);
    if (inner) return { xml: wrapMxCells(inner), source: 'sidecar' };
  }

  if (nvidiaKey) {
    const inner = await generateViaNim(prompt, timeoutMs);
    if (inner) return { xml: wrapMxCells(inner), source: 'nim' };
  }

  return null;
}
