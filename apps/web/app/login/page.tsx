'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, ArrowRight, ShieldCheck, Zap, Eye } from 'lucide-react';
import { devLogin, setToken, setUser } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/input';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('manager@dynamicsops.com');
  const [role, setRole] = useState('manager');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setErr('');
    try {
      const { accessToken, user } = await devLogin(email, role);
      setToken(accessToken); setUser(user);
      router.push('/');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand / story panel */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-foreground p-12 text-background lg:flex">
        <div className="absolute inset-0 mesh opacity-60" />
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-primary/30 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-5" /></div>
          <span className="text-lg font-semibold tracking-tight">DynamicsOps</span>
        </div>
        <div className="relative space-y-6">
          <h1 className="font-display text-4xl leading-tight tracking-tight text-balance">
            Your AI workforce — <span className="italic text-primary-foreground/90">receive, understand, execute, escalate.</span>
          </h1>
          <p className="max-w-md text-background/70">
            Ten specialized AI Resources triage every email, ticket, invoice and project task — drafting work and
            acting only after human approval. Full audit, every decision explained.
          </p>
          <div className="flex flex-wrap gap-4 pt-2 text-sm text-background/80">
            <span className="inline-flex items-center gap-2"><ShieldCheck className="size-4 text-primary-foreground" /> Draft-first, approval-gated</span>
            <span className="inline-flex items-center gap-2"><Eye className="size-4 text-primary-foreground" /> Fully explainable</span>
            <span className="inline-flex items-center gap-2"><Zap className="size-4 text-primary-foreground" /> Real-time</span>
          </div>
        </div>
        <div className="relative text-xs text-background/50">Microsoft Dynamics 365 · Outlook · Teams · Azure DevOps · Business Central</div>
      </div>

      {/* Login card */}
      <div className="flex items-center justify-center p-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="size-5" /></div>
          </div>
          <h2 className="font-display text-2xl tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to the AI Resource Platform.</p>

          <div className="mt-8 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@dynamicsops.com" />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Role (dev login)</label>
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="consultant">Consultant</option>
                <option value="viewer">Viewer</option>
              </Select>
            </div>
            <Button onClick={submit} disabled={busy} size="lg" className="w-full">
              {busy ? 'Signing in…' : <>Continue <ArrowRight className="size-4" /></>}
            </Button>
            <Button variant="outline" size="lg" className="w-full" disabled>
              Sign in with Microsoft Entra ID
            </Button>
            {err && <p className="text-sm text-danger">{err}</p>}
          </div>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Seeded: admin@ · manager@ · consultant@ · viewer@ dynamicsops.com
          </p>
        </div>
      </div>
    </div>
  );
}
