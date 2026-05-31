'use client';
import * as React from 'react';
import { Check, ChevronsUpDown, Plus, Sparkles } from 'lucide-react';
import { api, getWorkspaceId, setWorkspaceId } from '../lib/api';
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator } from './ui/dropdown';
import { cn } from '../lib/utils';

interface Workspace { id: string; name: string; slug: string; plan?: string; branding?: any; role?: string }

const Ctx = React.createContext<{ workspaces: Workspace[]; active: Workspace | null; switchTo: (id: string) => void }>({ workspaces: [], active: null, switchTo: () => {} });
export const useWorkspace = () => React.useContext(Ctx);

// Apply white-label branding: only hue + saturation (lightness stays theme-driven).
function applyBranding(ws: Workspace | null) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const b = ws?.branding ?? {};
  if (b.accent_hue != null) root.style.setProperty('--brand-h', String(b.accent_hue));
  else root.style.removeProperty('--brand-h');
  if (b.accent_sat != null) root.style.setProperty('--brand-s', `${b.accent_sat}%`);
  else root.style.removeProperty('--brand-s');
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [active, setActive] = React.useState<Workspace | null>(null);

  React.useEffect(() => {
    api('/workspaces').then((ws: Workspace[]) => {
      setWorkspaces(ws);
      const current = getWorkspaceId();
      const chosen = ws.find((w) => w.id === current) ?? ws[0] ?? null;
      if (chosen) { setWorkspaceId(chosen.id); setActive(chosen); applyBranding(chosen); }
    }).catch(() => {});
  }, []);

  const switchTo = (id: string) => {
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return;
    setWorkspaceId(id);
    applyBranding(ws);
    window.location.reload(); // re-scope all data under the new workspace
  };

  return <Ctx.Provider value={{ workspaces, active, switchTo }}>{children}</Ctx.Provider>;
}

export function WorkspaceSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { workspaces, active, switchTo } = useWorkspace();
  const brandName = active?.branding?.display_name ?? active?.name ?? 'DynamicsOps';

  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60', collapsed && 'justify-center')}>
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-glow"><Sparkles className="size-4" /></div>
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold tracking-tight">{brandName}</div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{active?.plan ?? 'workspace'}</div>
            </div>
          )}
          {!collapsed && <ChevronsUpDown className="size-3.5 text-muted-foreground" />}
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-60">
        <DropdownLabel>Workspaces</DropdownLabel>
        {workspaces.map((w) => (
          <DropdownItem key={w.id} onSelect={() => switchTo(w.id)}>
            <div className="grid size-6 place-items-center rounded bg-primary/15 text-[10px] font-semibold text-primary">{(w.branding?.display_name ?? w.name).slice(0, 2).toUpperCase()}</div>
            <span className="flex-1 truncate">{w.branding?.display_name ?? w.name}</span>
            {active?.id === w.id && <Check className="size-4 text-primary" />}
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem onSelect={() => (window.location.href = '/onboarding')}><Plus className="size-4" />New workspace</DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}
