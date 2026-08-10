'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input, Select, Textarea } from '../../../../components/ui/input';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Switch } from '../../../../components/ui/misc';
import { Trash2, Plus } from 'lucide-react';

const CHECKS = ['blocked_recipient_domains', 'external_recipient_allowlist', 'max_body_length', 'required_fields', 'quiet_hours_send'];

export default function RulesPage() {
  const [rules, setRules] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRule, setNewRule] = useState({ title: '', body: '', scope: 'workspace' });
  const [newHook, setNewHook] = useState({ tool_pattern: 'send_*', check: CHECKS[0], config: '{}', action: 'warn' });

  const load = useCallback(async () => {
    const [r, h] = await Promise.all([api('/rules'), api('/guard-hooks')]);
    setRules(r); setHooks(h); setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function addRule() {
    if (!newRule.title.trim() || !newRule.body.trim()) return;
    try {
      await api('/rules', { method: 'POST', body: JSON.stringify(newRule) });
      setNewRule({ title: '', body: '', scope: 'workspace' });
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  async function addHook() {
    try {
      const config = JSON.parse(newHook.config || '{}');
      await api('/guard-hooks', { method: 'POST', body: JSON.stringify({ ...newHook, config }) });
      setNewHook({ tool_pattern: 'send_*', check: CHECKS[0], config: '{}', action: 'warn' });
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  async function toggle(kind: 'rules' | 'guard-hooks', row: any) {
    try { await api(`/${kind}/${row.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !row.is_active }) }); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  async function remove(kind: 'rules' | 'guard-hooks', id: string) {
    try { await api(`/${kind}/${id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  if (loading) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;

  return (
    <div>
      <PageHeader title="Rules & Guard Hooks" subtitle="Kurallar her agent prompt'una koşulsuz eklenir; guard hook'lar tool çalışmadan ÖNCE deterministik olarak uygulanır (modele güvenmeden)." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle right={<Badge variant="neutral">{rules.length}</Badge>}>Always-on Rules</SectionTitle>
          <div className="space-y-3">
            {rules.map((r) => (
              <div key={r.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{r.title}</span>
                    <Badge variant="outline">{r.scope}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.body}</p>
                </div>
                <Switch checked={r.is_active} onCheckedChange={() => toggle('rules', r)} />
                <Button variant="ghost" size="sm" onClick={() => remove('rules', r.id)}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            <div className="rounded-lg border border-dashed border-border p-3">
              <div className="grid gap-2">
                <Input placeholder="Başlık" value={newRule.title} onChange={(e) => setNewRule({ ...newRule, title: e.target.value })} />
                <Textarea placeholder="Kural metni (örn. 'Müşteri e-postalarında her zaman TR yaz; fiyat bilgisi verme')" value={newRule.body} onChange={(e) => setNewRule({ ...newRule, body: e.target.value })} />
                <div className="flex gap-2">
                  <Input placeholder="Kapsam: workspace veya resource key" value={newRule.scope} onChange={(e) => setNewRule({ ...newRule, scope: e.target.value })} />
                  <Button onClick={addRule}><Plus className="size-4" /> Ekle</Button>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle right={<Badge variant="neutral">{hooks.length}</Badge>}>Guard Hooks</SectionTitle>
          <div className="space-y-3">
            {hooks.map((h) => (
              <div key={h.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{h.tool_pattern}</span>
                    <Badge variant="outline">{h.check}</Badge>
                    <Badge variant={h.action === 'block' ? 'danger' : 'warning'}>{h.action}</Badge>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{JSON.stringify(h.config)}</p>
                </div>
                <Switch checked={h.is_active} onCheckedChange={() => toggle('guard-hooks', h)} />
                <Button variant="ghost" size="sm" onClick={() => remove('guard-hooks', h.id)}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
            <div className="rounded-lg border border-dashed border-border p-3">
              <div className="grid gap-2">
                <div className="flex gap-2">
                  <Input placeholder="Tool pattern (send_*, *)" value={newHook.tool_pattern} onChange={(e) => setNewHook({ ...newHook, tool_pattern: e.target.value })} />
                  <Select value={newHook.check} onChange={(e) => setNewHook({ ...newHook, check: e.target.value })}>
                    {CHECKS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </div>
                <div className="flex gap-2">
                  <Input placeholder='Config JSON — örn {"domains":["gmail.com"]} / {"max":8000}' value={newHook.config} onChange={(e) => setNewHook({ ...newHook, config: e.target.value })} />
                  <Select value={newHook.action} onChange={(e) => setNewHook({ ...newHook, action: e.target.value })}>
                    <option value="warn">warn</option>
                    <option value="block">block</option>
                  </Select>
                  <Button onClick={addHook}><Plus className="size-4" /></Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
