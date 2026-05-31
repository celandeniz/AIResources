'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setWorkspaceId } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Sparkles, ArrowRight } from 'lucide-react';

const SWATCHES = [
  { name: 'Iris', h: 252, s: 83 }, { name: 'Ocean', h: 210, s: 90 }, { name: 'Emerald', h: 158, s: 64 },
  { name: 'Amber', h: 33, s: 92 }, { name: 'Rose', h: 346, s: 78 }, { name: 'Slate', h: 220, s: 20 },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [accent, setAccent] = useState(SWATCHES[0]);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const ws = await api('/workspaces', { method: 'POST', body: JSON.stringify({ name, branding: { display_name: name, accent_hue: accent.h, accent_sat: accent.s } }) });
      setWorkspaceId(ws.id);
      toast.success('Workspace created');
      window.location.href = '/';
    } catch (e: any) { toast.error(e.message); setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-lg py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-5" /></div>
        <div><h1 className="font-display text-2xl tracking-tight">Create a workspace</h1><p className="text-sm text-muted-foreground">Spin up an isolated, branded environment for a team or client.</p></div>
      </div>
      <Card className="space-y-6 p-6">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Workspace name</label>
          <Input placeholder="e.g. Contoso, Acme Consulting…" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="mb-2 block text-xs font-medium text-muted-foreground">Brand accent</label>
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map((sw) => (
              <button key={sw.name} onClick={() => setAccent(sw)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all ${accent.name === sw.name ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:bg-muted/50'}`}>
                <span className="size-4 rounded-full" style={{ background: `hsl(${sw.h} ${sw.s}% 58%)` }} />{sw.name}
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-border p-4" style={{ ['--brand-h' as any]: String(accent.h), ['--brand-s' as any]: `${accent.s}%` }}>
          <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Preview</div>
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-4" /></div>
            <span className="font-semibold">{name || 'Your workspace'}</span>
            <Button size="sm" className="ml-auto">Primary action</Button>
          </div>
        </div>
        <Button onClick={create} disabled={!name || busy} size="lg" className="w-full">{busy ? 'Creating…' : <>Create workspace <ArrowRight className="size-4" /></>}</Button>
      </Card>
    </div>
  );
}
