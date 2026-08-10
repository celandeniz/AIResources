// ECC-inspired guard hooks: deterministic pre-execution checks enforced in the
// executor, OUTSIDE the model. block → the tool_call fails with the reason;
// warn → proceeds with an audit entry. Config lives in the guard_hooks table
// (tool_pattern supports 'send_email', 'send_*', '*').

import type { PrismaService } from '../prisma/prisma.service';
import { nextAllowedSendTime } from './coverage/coverage-rules';

export interface GuardVerdict {
  allowed: boolean;
  warnings: string[];
  reason?: string;
}

function patternMatches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

function recipientsOf(args: any): string[] {
  const to = args?.to;
  const list = Array.isArray(to) ? to : to ? [to] : [];
  return list.map((r: unknown) => String(r).toLowerCase()).filter((r: string) => r.includes('@'));
}

function bodyOf(args: any): string {
  return String(args?.body ?? args?.content ?? args?.message ?? args?.text ?? '');
}

export async function runGuardHooks(
  prisma: PrismaService,
  workspaceId: string | null,
  tool: string,
  args: any,
): Promise<GuardVerdict> {
  let hooks: any[] = [];
  try {
    hooks = await (prisma as any).guard_hooks.findMany({ where: { is_active: true } });
  } catch {
    return { allowed: true, warnings: [] }; // table missing → no-op
  }
  const warnings: string[] = [];

  for (const hook of hooks) {
    if (!patternMatches(String(hook.tool_pattern), tool)) continue;
    const cfg = (hook.config as any) ?? {};
    let violation: string | null = null;

    switch (hook.check) {
      case 'blocked_recipient_domains': {
        const blocked: string[] = (cfg.domains ?? []).map((d: string) => d.toLowerCase());
        const hit = recipientsOf(args).find((r) => blocked.includes(r.split('@')[1] ?? ''));
        if (hit) violation = `recipient ${hit} is on the blocked-domain list`;
        break;
      }
      case 'external_recipient_allowlist': {
        const allowed: string[] = (cfg.domains ?? []).map((d: string) => d.toLowerCase());
        if (allowed.length) {
          const hit = recipientsOf(args).find((r) => !allowed.includes(r.split('@')[1] ?? ''));
          if (hit) violation = `recipient ${hit} is outside the allowlisted domains`;
        }
        break;
      }
      case 'max_body_length': {
        const max = Number(cfg.max ?? 8000);
        if (bodyOf(args).length > max) violation = `message body exceeds ${max} chars`;
        break;
      }
      case 'required_fields': {
        const fields: string[] = cfg.fields ?? [];
        const missing = fields.filter((f) => {
          const v = args?.[f];
          return v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
        });
        if (missing.length) violation = `missing required field(s): ${missing.join(', ')}`;
        break;
      }
      case 'quiet_hours_send': {
        const window = String(cfg.hours ?? '18-08');
        const now = new Date();
        if (nextAllowedSendTime(now, window) > now) violation = `quiet hours (${window}) — send deferred to business hours`;
        break;
      }
      default:
        continue; // unknown check → ignore (forward-compatible)
    }

    if (violation) {
      if (hook.action === 'block') {
        return { allowed: false, warnings, reason: `[guard:${hook.check}] ${violation}` };
      }
      warnings.push(`[guard:${hook.check}] ${violation}`);
    }
  }
  return { allowed: true, warnings };
}
