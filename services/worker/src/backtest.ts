import { PrismaClient } from '@dynops/db';
import { LLM_PROVIDERS, TOOL_REGISTRY, isKnownTool, type AgentRunRequest } from '@dynops/shared';
import { matchRoutingRule, type RuleRow } from './rules';
import { runAgent } from './agent-client';

const prisma = new PrismaClient();
const POOL = Number(process.env.BACKTEST_CONCURRENCY ?? 5);

const channelFor = (source: string) => (source === 'devops' ? 'devops' : source === 'teams' ? 'teams' : 'email');

// Simulate the AI workforce over historical items (Outlook/Teams/ADO). PURE dry-run:
// routes + calls the agent (proposer only), classifies the decision, records on
// backtest_items. Creates NO activities/approvals/messages/audit.
export async function runBacktest(backtestId: string) {
  const bt = await prisma.backtests.findUnique({ where: { id: backtestId } });
  if (!bt) throw new Error(`backtest ${backtestId} not found`);
  const wsId = bt.workspace_id;
  const modelOverride = (bt.config as any)?.model_override as string | null;
  await prisma.backtests.update({ where: { id: backtestId }, data: { status: 'running' } });

  const items = await prisma.backtest_items.findMany({ where: { backtest_id: backtestId } });
  const rules = (await prisma.workflow_rules.findMany({ where: { is_active: true, workspace_id: wsId } })) as unknown as RuleRow[];
  const resourceCache = new Map<string, any>();

  const acc = { auto: 0, approval: 0, escalate: 0, none: 0, confSum: 0, confN: 0, byResource: {} as Record<string, { name: string; count: number }> };

  async function processItem(item: any) {
    try {
      const channel = channelFor(item.source);
      const record = { channel, type: channel === 'email' ? 'email' : channel, subject: item.subject ?? '', body: item.body ?? '', category: '', customer_id: null, project_id: null, priority: 'normal' };
      const rule = matchRoutingRule(rules, record);
      if (!rule?.target_resource_id) {
        await prisma.backtest_items.update({ where: { id: item.id }, data: { decision: 'none', reasoning: 'No routing rule matched.' } });
        acc.none++; return;
      }
      let resource = resourceCache.get(rule.target_resource_id);
      if (!resource) { resource = await prisma.ai_resources.findUnique({ where: { id: rule.target_resource_id } }); resourceCache.set(rule.target_resource_id, resource); }
      if (!resource) { acc.none++; return; }
      const threshold = Number(resource.confidence_threshold);
      // Overrides accept a provider prefix ('nvidia/meta/llama-3.1-8b-instruct');
      // bare model names ('gemma3') stay on Ollama for back-compat.
      let provider = resource.llm_provider as string;
      let model = resource.llm_model;
      if (modelOverride) {
        const slash = modelOverride.indexOf('/');
        const maybe = slash > 0 ? modelOverride.slice(0, slash) : '';
        if ((LLM_PROVIDERS as readonly string[]).includes(maybe)) {
          provider = maybe;
          model = modelOverride.slice(slash + 1);
        } else {
          provider = 'ollama';
          model = modelOverride;
        }
      }

      const req: AgentRunRequest = {
        run_id: `bt-${item.id}`,
        workspace_id: wsId ?? undefined,
        ai_resource: { key: resource.key, name: resource.name, system_prompt: resource.system_prompt, provider, model, temperature: Number(resource.temperature), tools: (resource.allowed_tools as string[]) ?? [], confidence_threshold: threshold },
        activity: { id: item.id, channel, subject: item.subject, body: item.body, priority: 'normal', received_at: item.received_at?.toISOString() },
        context: { thread: item.from_address ? [{ role: 'external', from: item.from_address, text: item.body ?? '' }] : [], rag_hints: [] },
        options: { max_tool_intents: 5 },
      };

      const started = Date.now();
      const resp = await runAgent(req);
      const latency = Date.now() - started;
      const confidence = resp.confidence ?? 0.5;
      const intents = resp.tool_intents ?? [];
      const hasSensitive = intents.some((i) => (isKnownTool(i.tool) ? TOOL_REGISTRY[i.tool].sensitive : i.sensitive) ?? false);
      const decision = resp.needs_escalation ? 'escalate' : hasSensitive || confidence < threshold ? 'approval' : 'auto';

      await prisma.backtest_items.update({
        where: { id: item.id },
        data: { routed_resource_id: resource.id, routed_resource_name: resource.name, draft: resp.draft as any, reasoning: resp.reasoning_summary, confidence, tool_intents: intents as any, decision, provider: resp.provider ?? provider, model: resp.model ?? model, latency_ms: latency },
      });
      (acc as any)[decision]++; acc.confSum += confidence; acc.confN++;
      acc.byResource[resource.id] ??= { name: resource.name, count: 0 };
      acc.byResource[resource.id].count++;
    } catch (e) {
      await prisma.backtest_items.update({ where: { id: item.id }, data: { decision: 'none', error: (e as Error).message } });
      acc.none++;
    } finally {
      await prisma.backtests.update({ where: { id: backtestId }, data: { processed: { increment: 1 } } });
    }
  }

  // bounded concurrency pool
  let cursor = 0;
  async function pump() {
    while (cursor < items.length) {
      const item = items[cursor++];
      await processItem(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, () => pump()));

  const handled = acc.auto + acc.approval + acc.escalate;
  const hoursSaved = Math.round((handled * 15) / 60 * 10) / 10;
  const summary = {
    hoursSaved, valueSaved: Math.round(hoursSaved * 85),
    autoCount: acc.auto, approvalCount: acc.approval, escalateCount: acc.escalate, noneCount: acc.none,
    avgConfidence: acc.confN ? Math.round((acc.confSum / acc.confN) * 100) / 100 : null,
    byResource: Object.values(acc.byResource).sort((a, b) => b.count - a.count),
  };
  await prisma.backtests.update({ where: { id: backtestId }, data: { status: 'done', summary: summary as any } });
}
