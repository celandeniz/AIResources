'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Skeleton } from '../../../components/ui/skeleton';
import { Avatar, Switch } from '../../../components/ui/misc';
import { Sheet, SheetContent, SheetTrigger } from '../../../components/ui/sheet';
import { Select, Textarea } from '../../../components/ui/input';
import { Input } from '../../../components/ui/input';
import { Cpu, ShieldCheck, Mail } from 'lucide-react';

const PROVIDERS: Record<string, string[]> = {
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'qwen/qwen2.5-coder-32b-instruct',
    'meta/llama-3.1-8b-instruct',
    'meta/llama-3.1-70b-instruct',
    'mistralai/mistral-small-24b-instruct',
  ],
  ollama: ['qwen3', 'qwen2.5-coder:14b', 'deepseek-r1', 'gemma3', 'gpt-oss:20b', 'mistral-small'],
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  azure_openai: ['gpt-4o'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};

export default function DirectoryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setItems(await api('/ai-resources')); setLoading(false); }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);
  const operational = items.filter((r) => resourceCategory(r) !== 'consulting');
  const consulting = items.filter((r) => resourceCategory(r) === 'consulting');

  return (
    <div>
      <PageHeader title="AI Resource Directory" subtitle="Operational and consulting AI resources — role, model, tools, guardrails." />
      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">{[0,1,2,3].map(i => <Skeleton key={i} className="h-44" />)}</div>
      ) : (
        <div className="space-y-8">
          <ResourceGroup title="Operational resources" count={operational.length} items={operational} onSaved={load} />
          <ResourceGroup title="Consulting resources" count={consulting.length} items={consulting} onSaved={load} />
        </div>
      )}
    </div>
  );
}

function resourceCategory(r: any) {
  return (r.config?.category as string | undefined) ?? 'operational';
}

function resourceSkill(r: any) {
  return (r.config?.skill as string | undefined) ?? r.key;
}

function ResourceGroup({ title, count, items, onSaved }: { title: string; count: number; items: any[]; onSaved: () => void }) {
  if (!items.length) return null;
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="neutral">{count}</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((r) => <ResourceCard key={r.id} r={r} onSaved={onSaved} />)}
      </div>
    </section>
  );
}

function ResourceCard({ r, onSaved }: { r: any; onSaved: () => void }) {
  const PROVIDER_LABEL: Record<string, string> = { nvidia: 'NVIDIA NIM', anthropic: 'Claude', openai: 'ChatGPT', azure_openai: 'Azure', gemini: 'Gemini' };
  const tierBadge = r.llm_provider === 'ollama'
    ? <Badge variant="success">free · local</Badge>
    : r.llm_provider === 'nvidia'
      ? <Badge variant="success">free · cloud</Badge>
      : <Badge variant="default">{PROVIDER_LABEL[r.llm_provider] ?? r.llm_provider}</Badge>;
  const category = resourceCategory(r);
  const skill = resourceSkill(r);
  return (
    <Card className="group flex flex-col p-5 transition-shadow hover:shadow-md">
      <div className="flex items-start gap-3">
        <Avatar name={r.name} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{r.name}</span>
            <Badge variant={r.status === 'active' ? 'success' : 'neutral'}>{r.status}</Badge>
          </div>
          <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{r.role}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <Badge variant={category === 'consulting' ? 'default' : 'outline'}>{category}</Badge>
        <Badge variant="outline">{skill}</Badge>
        {tierBadge}
        <Badge variant="neutral"><Cpu className="size-3" />{r.llm_model}</Badge>
        <Badge variant="outline">conf ≥ {Number(r.confidence_threshold).toFixed(2)}</Badge>
        {r.approval_limit != null && <Badge variant="outline">${Number(r.approval_limit).toLocaleString()}</Badge>}
      </div>
      <div className="mt-3 line-clamp-1 text-xs text-muted-foreground">{(r.allowed_tools as string[]).join(' · ')}</div>
      {r.email && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Mail className="size-3 shrink-0" />
          <span className="truncate">{r.email}</span>
        </div>
      )}
      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="size-3.5" /> Draft-first</span>
        <Sheet>
          <SheetTrigger asChild><Button variant="outline" size="sm">Configure</Button></SheetTrigger>
          <SheetContent title={r.name}><ResourceEditor r={r} onSaved={onSaved} /></SheetContent>
        </Sheet>
      </div>
    </Card>
  );
}

function ResourceEditor({ r, onSaved }: { r: any; onSaved: () => void }) {
  const [provider, setProvider] = useState(r.llm_provider);
  const [model, setModel] = useState(r.llm_model);
  const [email, setEmail] = useState(r.email ?? '');
  const [prompt, setPrompt] = useState(r.system_prompt);
  const [versions, setVersions] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const loadVersions = useCallback(async () => setVersions(await api(`/ai-resources/${r.id}/prompt-versions`)), [r.id]);
  useEffect(() => { loadVersions().catch(() => {}); }, [loadVersions]);

  async function save() {
    setSaving(true);
    try {
      await api(`/ai-resources/${r.id}`, { method: 'PATCH', body: JSON.stringify({ llm_provider: provider, llm_model: model, email }) });
      toast.success(`${r.name} updated`); onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  async function savePrompt() {
    setSaving(true);
    try {
      await api(`/ai-resources/${r.id}/prompt-versions`, { method: 'POST', body: JSON.stringify({ system_prompt: prompt }) });
      toast.success('Prompt version saved');
      await loadVersions();
      onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  async function rollback(version: number) {
    setSaving(true);
    try {
      const row: any = await api(`/ai-resources/${r.id}/prompt-versions/${version}/rollback`, { method: 'POST' });
      setPrompt(row.system_prompt);
      toast.success(`Rolled back to v${version}`);
      await loadVersions();
      onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Avatar name={r.name} className="size-12" />
        <div><div className="font-medium">{r.name}</div><div className="text-sm text-muted-foreground">{r.role}</div></div>
      </div>

      <Section title="Model & provider">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">Provider</label>
            <Select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(PROVIDERS[e.target.value]?.[0] ?? model); }}>
              <option value="nvidia">NVIDIA NIM (free/cloud)</option>
              <option value="ollama">Ollama (free/local)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (ChatGPT)</option>
              <option value="azure_openai">Azure OpenAI</option>
              <option value="gemini">Google Gemini</option>
            </Select>
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">Model</label>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {(PROVIDERS[provider] ?? [model]).map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </div>
        </div>
        <Button onClick={save} disabled={saving} className="mt-3">{saving ? 'Saving…' : 'Save model'}</Button>
      </Section>

      <Section title="Mailbox">
        <label className="mb-1.5 block text-xs text-muted-foreground">Role email address</label>
        <Input
          type="email"
          placeholder="resource@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button onClick={save} disabled={saving} className="mt-3">{saving ? 'Saving…' : 'Save email'}</Button>
      </Section>

      <Section title="Guardrails">
        <Row label="Confidence threshold" value={Number(r.confidence_threshold).toFixed(2)} />
        <Row label="Approval limit" value={r.approval_limit != null ? `$${Number(r.approval_limit).toLocaleString()}` : 'none'} />
        <Row label="Status"><Switch defaultChecked={r.status === 'active'} /></Row>
      </Section>

      <Section title="Allowed tools">
        <div className="flex flex-wrap gap-1.5">{(r.allowed_tools as string[]).map((t) => <Badge key={t} variant="neutral">{t}</Badge>)}</div>
      </Section>

      <Section title="System prompt">
        <Textarea className="min-h-64 font-mono text-xs leading-relaxed" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <Button onClick={savePrompt} disabled={saving || prompt === r.system_prompt} className="mt-3">Save prompt version</Button>
      </Section>

      <Section title="Prompt history">
        <div className="space-y-2">
          {versions.map((v) => (
            <div key={v.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">v{v.version} <span className="text-xs font-normal text-muted-foreground">{new Date(v.created_at).toLocaleString()}</span></div>
                <Button variant="outline" size="sm" onClick={() => rollback(v.version)} disabled={saving}>Rollback</Button>
              </div>
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{promptDiff(r.system_prompt, v.system_prompt)}</pre>
            </div>
          ))}
          {versions.length === 0 && <div className="text-sm text-muted-foreground">No prompt history yet.</div>}
        </div>
      </Section>
    </div>
  );
}

function promptDiff(current: string, previous: string) {
  if (current === previous) return 'No diff from current prompt.';
  const currentLines = new Set(current.split('\n').map((x) => x.trim()).filter(Boolean));
  const previousLines = previous.split('\n').map((x) => x.trim()).filter(Boolean);
  const removed = previousLines.filter((line) => !currentLines.has(line)).slice(0, 8);
  return removed.length ? removed.map((line) => `- ${line}`).join('\n') : 'Prompt differs from current version.';
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>{children}</div>
);
const Row = ({ label, value, children }: { label: string; value?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="flex items-center justify-between border-b border-border py-2 text-sm last:border-0"><span className="text-muted-foreground">{label}</span>{children ?? <span className="font-mono tnum">{value}</span>}</div>
);
