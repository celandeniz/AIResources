'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { useWorkspace } from '../../../../components/workspace';
import { PageHeader, SectionTitle } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';

const SWATCHES = [
  { name: 'Iris', h: 252, s: 83 }, { name: 'Ocean', h: 210, s: 90 }, { name: 'Emerald', h: 158, s: 64 },
  { name: 'Amber', h: 33, s: 92 }, { name: 'Rose', h: 346, s: 78 }, { name: 'Slate', h: 220, s: 20 },
];

export default function WorkspaceSettings() {
  const { active } = useWorkspace();
  const [ws, setWs] = useState<any>(null);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState(SWATCHES[0]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/workspaces/current').then((w) => {
      if (!w) return;
      setWs(w); setName(w.branding?.display_name ?? w.name);
      if (w.branding?.accent_hue != null) setAccent({ name: 'Custom', h: w.branding.accent_hue, s: w.branding.accent_sat ?? 80 });
    }).catch(() => {});
  }, [active?.id]);

  async function save() {
    if (!ws) return;
    setBusy(true);
    try {
      await api(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ name, branding: { ...(ws.branding ?? {}), display_name: name, accent_hue: accent.h, accent_sat: accent.s } }) });
      document.documentElement.style.setProperty('--brand-h', String(accent.h));
      document.documentElement.style.setProperty('--brand-s', `${accent.s}%`);
      toast.success('Branding saved');
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="Workspace" subtitle="White-label branding, plan and limits for this workspace." />
      <Card className="max-w-2xl space-y-6 p-6">
        <div>
          <SectionTitle>Brand</SectionTitle>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Display name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-muted-foreground">Accent color</label>
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map((sw) => (
              <button key={sw.name} onClick={() => setAccent(sw)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all ${accent.h === sw.h ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:bg-muted/50'}`}>
                <span className="size-4 rounded-full" style={{ background: `hsl(${sw.h} ${sw.s}% 58%)` }} />{sw.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="text-sm text-muted-foreground">Plan: <span className="font-medium text-foreground capitalize">{ws?.plan ?? '—'}</span></div>
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save branding'}</Button>
        </div>
      </Card>
    </div>
  );
}
