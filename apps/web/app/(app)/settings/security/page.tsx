'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Switch } from '../../../../components/ui/misc';
import { ShieldCheck, Lock, FileLock2, Server, KeyRound, ScrollText } from 'lucide-react';

export default function SecuritySettings() {
  const [ws, setWs] = useState<any>(null);
  const [pii, setPii] = useState(true);
  const [retention, setRetention] = useState(365);

  useEffect(() => {
    api('/workspaces/current').then((w) => {
      if (!w) return; setWs(w);
      setPii(w.limits?.pii_redaction ?? true);
      setRetention(w.limits?.retention_days ?? 365);
    }).catch(() => {});
  }, []);

  async function save(next: { pii?: boolean; retention?: number }) {
    if (!ws) return;
    const limits = { ...(ws.limits ?? {}), pii_redaction: next.pii ?? pii, retention_days: next.retention ?? retention };
    try { await api(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ limits }) }); setWs({ ...ws, limits }); toast.success('Security settings saved'); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <div>
      <PageHeader title="Security & governance" subtitle="Compliance posture for this workspace." />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Data governance</SectionTitle>
          <Toggle icon={FileLock2} title="PII redaction" desc="Strip detected PII before sending context to LLM providers." checked={pii} onChange={(v) => { setPii(v); save({ pii: v }); }} />
          <div className="flex items-center justify-between border-t border-border py-3">
            <div className="flex items-center gap-2.5"><Server className="size-4 text-muted-foreground" /><div><div className="text-sm font-medium">Data retention</div><div className="text-xs text-muted-foreground">Days to keep activity history</div></div></div>
            <select value={retention} onChange={(e) => { const v = Number(e.target.value); setRetention(v); save({ retention: v }); }} className="h-8 rounded-lg border border-input bg-card px-2 text-sm">
              {[90, 180, 365, 730].map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Posture</SectionTitle>
          <Posture icon={ShieldCheck} title="Draft-first execution" status="Enforced" desc="No external action runs without passing the approval gate." ok />
          <Posture icon={ScrollText} title="Immutable audit log" status="Append-only (DB trigger)" desc="Every route, draft, approval & execution is recorded." ok />
          <Posture icon={Lock} title="Tenant isolation" status="Per-workspace (Prisma guard)" desc="Queries are workspace-scoped at the data layer." ok />
          <Posture icon={KeyRound} title="SSO — Microsoft Entra ID" status="Available" desc="Switch AUTH_MODE=entra to enforce org SSO." />
        </Card>

        <Card className="p-5 lg:col-span-2">
          <SectionTitle>Where your data lives</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <DataLoc label="Platform data" value="PostgreSQL (self-hosted)" />
            <DataLoc label="Knowledge vectors" value="Qdrant (self-hosted)" />
            <DataLoc label="LLM providers" value="Local Ollama + Claude/ChatGPT (no-train)" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Toggle({ icon: Icon, title, desc, checked, onChange }: any) {
  return (
    <div className="flex items-center justify-between border-t border-border py-3 first:border-t-0">
      <div className="flex items-center gap-2.5"><Icon className="size-4 text-muted-foreground" /><div><div className="text-sm font-medium">{title}</div><div className="text-xs text-muted-foreground">{desc}</div></div></div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
function Posture({ icon: Icon, title, status, desc, ok }: any) {
  return (
    <div className="flex items-start gap-2.5 border-t border-border py-3 first:border-t-0">
      <Icon className={`mt-0.5 size-4 ${ok ? 'text-success' : 'text-muted-foreground'}`} />
      <div className="flex-1"><div className="flex items-center gap-2"><span className="text-sm font-medium">{title}</span><Badge variant={ok ? 'success' : 'neutral'}>{status}</Badge></div><div className="text-xs text-muted-foreground">{desc}</div></div>
    </div>
  );
}
function DataLoc({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-muted/20 p-3"><div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div>;
}
