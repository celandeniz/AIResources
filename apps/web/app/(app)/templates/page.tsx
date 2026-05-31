'use client';
import * as React from 'react';
import { FileText, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { PageHeader } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input, Textarea, Select } from '../../../components/ui/input';
import { toast } from '../../../components/ui/toaster';

const TYPES = ['proposal', 'sow', 'status_report', 'test_plan', 'design_note', 'email', 'social_post', 'product_announcement'];

export default function TemplatesPage() {
  const [items, setItems] = React.useState<any[]>([]);
  const [draft, setDraft] = React.useState({ name: '', type: TYPES[0], content: '' });
  const [mining, setMining] = React.useState(false);
  const load = React.useCallback(async () => setItems(await api('/templates')), []);
  React.useEffect(() => { load().catch(() => {}); }, [load]);

  async function create() {
    await api('/templates', { method: 'POST', body: JSON.stringify(draft) });
    setDraft({ name: '', type: TYPES[0], content: '' });
    toast.success('Template created');
    await load();
  }

  async function remove(id: string) {
    await api(`/templates/${id}`, { method: 'DELETE' });
    toast.success('Template deleted');
    await load();
  }

  async function mineProposals() {
    setMining(true);
    try {
      const result = await api('/proposal-templates/mine', { method: 'POST', body: JSON.stringify({ mailbox: 'deniz@dynamicsops.com', days: 365, cap: 50 }) });
      toast.success(`Scanned ${result.scanned}, created ${result.created}, skipped ${result.skipped}`);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setMining(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Templates"
        subtitle="Reusable client-ready content for proposals, reports, and delivery notes."
        actions={<Button onClick={mineProposals} disabled={mining}><Search className="size-4" />{mining ? 'Mining…' : 'Mine sent proposals'}</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <Card className="p-4">
          <div className="mb-3 text-sm font-semibold">New template</div>
          <div className="space-y-3">
            <Input placeholder="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Textarea className="min-h-48" placeholder="Template content" value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            <Button onClick={create} disabled={!draft.name || !draft.content}><Plus />Create</Button>
          </div>
        </Card>
        <div className="space-y-3">
          {items.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex items-start gap-3">
                <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{t.name}</div>
                    <Badge variant="outline">{t.type}</Badge>
                  </div>
                  <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{t.content}</pre>
                </div>
                <Button variant="ghost" size="icon" onClick={() => remove(t.id)} aria-label="Delete template"><Trash2 /></Button>
              </div>
            </Card>
          ))}
          {items.length === 0 && <Card className="p-6 text-sm text-muted-foreground">No templates yet.</Card>}
        </div>
      </div>
    </div>
  );
}
