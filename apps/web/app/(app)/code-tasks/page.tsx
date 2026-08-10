'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input, Select, Textarea } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import { Code2, Plus, Clock } from 'lucide-react';

interface CodeTaskRow {
  id: string;
  title: string;
  repo?: string;
  model?: string;
  agent?: string;
  status: string;
  created_at: string;
}

const MODEL_OPTIONS = [
  'ollama/qwen2.5-coder:14b',
  'nvidia/qwen/qwen2.5-coder-32b-instruct',
  'nvidia/meta/llama-3.3-70b-instruct',
  'ollama/deepseek-r1:14b',
  'ollama/gpt-oss:20b',
  'anthropic/claude-opus-4-8',
];

const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'warning',
  approved: 'warning',
  running: 'warning',
  done: 'success',
  failed: 'danger',
};

export default function CodeTasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<CodeTaskRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // Form state
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState(MODEL_OPTIONS[0]);
  const [agent, setAgent] = useState('build');

  function reload() {
    api('/code-tasks').then((d: any[]) => {
      setTasks(d ?? []);
      setLoadingHistory(false);
    }).catch(() => setLoadingHistory(false));
  }

  useEffect(() => { reload(); }, []);

  async function create() {
    if (!title.trim()) { toast.error('Lütfen bir başlık girin'); return; }
    if (!instruction.trim()) { toast.error('Lütfen görev tanımını girin'); return; }

    setBusy(true);
    try {
      await api('/code-tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          repo: repo.trim() || undefined,
          instruction: instruction.trim(),
          model,
          agent: agent.trim() || 'build',
        }),
      });
      toast.success('Kod görevi oluşturuldu — Onay Merkezi\'nde inceleme bekliyor.');
      setTitle('');
      setRepo('');
      setInstruction('');
      reload();
    } catch (e: any) {
      toast.error(e.message ?? 'Kod görevi oluşturulamadı');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Code Tasks"
        subtitle="OpenCode üzerinden onay denetimli yapay zeka kod görevleri. Hiçbir şey otomatik commit/push edilmez — inceleme için diff döner."
        actions={<Badge variant="neutral"><Code2 className="size-3" />Code Task</Badge>}
      />

      {/* Create card */}
      <Card className="mb-8 p-6">
        <SectionTitle>Kod Görevi Oluştur</SectionTitle>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Başlık</label>
            <Input
              placeholder="örn. Sipariş servisine null-check ekle"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Repo</label>
            <Input
              placeholder="dynamicsops/DynOpsBC"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Model</label>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Agent</label>
            <Input
              placeholder="build"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Görev Tanımı</label>
          <Textarea
            rows={6}
            placeholder="Yapay zekanın yapmasını istediğiniz değişikliği açıklayın…"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </div>

        <div className="mt-5">
          <Button onClick={create} disabled={busy || !title.trim() || !instruction.trim()}>
            <Plus className="size-4" />
            {busy ? 'Oluşturuluyor…' : 'Görev Oluştur'}
          </Button>
        </div>
      </Card>

      {/* History */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-5 py-3">
          <SectionTitle>Son Görevler</SectionTitle>
        </div>

        {loadingHistory ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">Yükleniyor…</div>
        ) : tasks.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Henüz görev yok. Yukarıdan bir tane oluşturun.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3">Görev</th>
                <th className="px-5 py-3">Model</th>
                <th className="px-5 py-3">Durum</th>
                <th className="px-5 py-3">Tarih</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr
                  key={t.id}
                  className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                  onClick={() => router.push(`/code-tasks/${t.id}`)}
                >
                  <td className="px-5 py-3">
                    <div className="font-medium text-foreground">{t.title}</div>
                    {t.repo && <div className="text-xs text-muted-foreground">{t.repo}</div>}
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">{t.model ?? '—'}</td>
                  <td className="px-5 py-3">
                    <Badge variant={STATUS_VARIANT[t.status] ?? 'neutral'} className="capitalize">{t.status}</Badge>
                  </td>
                  <td className="px-5 py-3 text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Clock className="size-3" />
                      {new Date(t.created_at).toLocaleDateString('tr-TR')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
