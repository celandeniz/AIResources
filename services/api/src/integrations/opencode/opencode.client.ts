import { Logger } from '@nestjs/common';

// ─────────────────────────────────────────────────────────────────────────────
// OpenCode HTTP client — drives a headless `opencode serve` instance for the
// approval-gated `code_task` tool. Dependency-free (global fetch). When the
// server isn't configured, runs in MOCK mode like other integrations degrade.
// See infra/opencode-setup.md for the server contract + env vars.
// ─────────────────────────────────────────────────────────────────────────────

const logger = new Logger('OpenCodeClient');

// Multi-repo: OPENCODE_SERVERS='dynopsbc=http://host:4096,airesources=http://host:4097'
// maps a repo key to its own `opencode serve` instance (one server binds one
// working dir). OPENCODE_SERVER_URL stays the default/fallback server.
export function serverFor(repo?: string): string | null {
  const map = Object.fromEntries(
    (process.env.OPENCODE_SERVERS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).toLowerCase(), p.slice(i + 1)] as [string, string];
      }),
  );
  const key = (repo ?? '').toLowerCase().split('/').pop() ?? '';
  return map[key] ?? process.env.OPENCODE_SERVER_URL ?? null;
}

export function opencodeConfigured(repo?: string): boolean {
  return Boolean(serverFor(repo));
}

export interface CodeTaskResult {
  ok: boolean;
  mock?: boolean;
  summary: string;
  diff?: string;
  shareUrl?: string;
  detail?: string;
}

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return { authorization: `Basic ${token}` };
}

export async function runCodeTask(opts: {
  instruction: string;
  model?: string;
  agent?: string;
  repo?: string;
  branch?: string;
}): Promise<CodeTaskResult> {
  if (!opencodeConfigured(opts.repo)) {
    return {
      ok: true,
      mock: true,
      summary: 'MOCK: OpenCode not configured. Would run code task: ' + opts.instruction.slice(0, 200),
      diff: '',
    };
  }

  const base = serverFor(opts.repo)!.replace(/\/$/, '');
  const model = opts.model ?? process.env.OPENCODE_MODEL ?? 'ollama/qwen2.5-coder:14b';
  const agent = opts.agent ?? process.env.OPENCODE_AGENT ?? 'build';

  // Branch-isolated work: OpenCode commits + pushes the branch; the platform
  // opens the PR from it. Never main, never merge.
  const instruction = opts.branch
    ? `Work ONLY on branch '${opts.branch}': create it from origin/main if it doesn't exist, ` +
      `check it out, make the changes, commit with a conventional message, and push the branch ` +
      `to origin. Do NOT merge, do NOT touch other branches, do NOT push to main.\n\n${opts.instruction}`
    : opts.instruction;

  // Real dev tasks (compile+test loops) far exceed 2 minutes.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENCODE_TIMEOUT_MS ?? 1_800_000));

  const headers = { 'content-type': 'application/json', ...authHeader() };

  try {
    // 1. Create a session.
    const sessionRes = await fetch(`${base}/session`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    if (!sessionRes.ok) {
      const text = await sessionRes.text();
      return { ok: false, summary: '', detail: `OpenCode error: session ${sessionRes.status}: ${text}` };
    }
    const session: any = await sessionRes.json();
    const sessionId = session?.id;
    if (!sessionId) {
      return { ok: false, summary: '', detail: 'OpenCode error: session response had no id' };
    }

    // 2. Send the instruction as a message.
    const msgRes = await fetch(`${base}/session/${sessionId}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        agent,
        parts: [{ type: 'text', text: instruction }],
      }),
      signal: controller.signal,
    });
    if (!msgRes.ok) {
      const text = await msgRes.text();
      return { ok: false, summary: '', detail: `OpenCode error: message ${msgRes.status}: ${text}` };
    }
    const message: any = await msgRes.json();

    // 3. Assemble summary + diff from the response parts. The message response
    //    shape varies between OpenCode versions — parts may live at the top
    //    level (`parts`) or nested under `message.parts`. Be liberal.
    const parts: any[] = Array.isArray(message?.parts)
      ? message.parts
      : Array.isArray(message?.message?.parts)
        ? message.message.parts
        : [];

    const textParts = parts
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string);
    let summary = textParts.join('\n').trim().slice(0, 4000);
    if (!summary) summary = 'OpenCode completed the task (no text summary returned).';

    // Diff: best-effort — collect parts whose type mentions patch/edit/file.
    const diffParts = parts.filter((p) => {
      const t = String(p?.type ?? '').toLowerCase();
      return t.includes('patch') || t.includes('edit') || t.includes('file');
    });
    const diff = diffParts.length ? JSON.stringify(diffParts, null, 2) : '';

    // Share url, if the session response exposes one.
    const shareUrl: string | undefined =
      session?.share?.url ?? session?.shareUrl ?? session?.share_url ?? undefined;

    logger.log(`code_task ran on session ${sessionId} (model=${model}, agent=${agent})`);
    return { ok: true, summary, diff, shareUrl };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return { ok: false, summary: '', detail: 'OpenCode error: ' + msg };
  } finally {
    clearTimeout(timeout);
  }
}
