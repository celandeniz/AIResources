'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input, Textarea } from '../../../components/ui/input';
import { Skeleton } from '../../../components/ui/skeleton';
import { Sparkles, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { getUser } from '../../../lib/api';

export default function SkillsPage() {
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create form state
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [promptFragment, setPromptFragment] = useState('');
  const [toolsRaw, setToolsRaw] = useState('');

  const user = getUser();
  const isAdmin = user?.role === 'admin';

  async function load() {
    try { setSkills(await api('/skills')); } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function create() {
    const toolsList = toolsRaw.split(',').map((t) => t.trim()).filter(Boolean);
    setBusy(true);
    try {
      await api('/skills', {
        method: 'POST',
        body: JSON.stringify({ key, name, description, prompt_fragment: promptFragment, tools: toolsList }),
      });
      toast.success('Skill created');
      setKey(''); setName(''); setDescription(''); setPromptFragment(''); setToolsRaw('');
      setShowCreate(false);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(skill: any) {
    try {
      await api(`/skills/${skill.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !skill.is_active }) });
      await load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div>
      <PageHeader
        title="Skills Registry"
        subtitle="Composable, versioned skill units that can be attached to any AI Resource — they append prompt fragments and union tools at run time."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="neutral"><Sparkles className="size-3" />Workforce</Badge>
            {isAdmin && (
              <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
                <Plus className="size-4" />{showCreate ? 'Cancel' : 'New Skill'}
              </Button>
            )}
          </div>
        }
      />

      {/* Create form */}
      {showCreate && isAdmin && (
        <Card className="mb-6 p-5 space-y-3">
          <SectionTitle>Create Skill</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Key (e.g. my-skill)" value={key} onChange={(e) => setKey(e.target.value)} />
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <Textarea
            placeholder="Prompt fragment — appended to the resource's system prompt at run time…"
            rows={5}
            value={promptFragment}
            onChange={(e) => setPromptFragment(e.target.value)}
          />
          <Input
            placeholder="Tools (comma-separated, optional, e.g. run_report,make_chart)"
            value={toolsRaw}
            onChange={(e) => setToolsRaw(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={create} disabled={!key.trim() || !name.trim() || !promptFragment.trim() || busy}>
              {busy ? 'Creating…' : 'Create Skill'}
            </Button>
          </div>
        </Card>
      )}

      {loading && (
        <div className="space-y-3 mt-4">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      )}

      {!loading && skills.length === 0 && (
        <EmptyState icon={Sparkles} title="No skills yet" description="Create your first skill to start augmenting AI Resources." />
      )}

      {!loading && skills.length > 0 && (
        <div className="space-y-3 mt-4">
          {skills.map((skill) => (
            <Card key={skill.id} className="overflow-hidden">
              <div
                className="flex cursor-pointer items-center gap-3 px-5 py-4 hover:bg-muted/20"
                onClick={() => setExpanded(expanded === skill.id ? null : skill.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{skill.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground">{skill.key}</code>
                    <Badge variant={skill.is_active ? 'success' : 'neutral'} className="text-[10px]">
                      {skill.is_active ? 'active' : 'inactive'}
                    </Badge>
                    {skill.version > 1 && <Badge variant="neutral" className="text-[10px]">v{skill.version}</Badge>}
                  </div>
                  {skill.description && <p className="mt-0.5 text-xs text-muted-foreground truncate">{skill.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {Array.isArray(skill.tools) && skill.tools.length > 0 && (
                    <div className="flex gap-1">
                      {(skill.tools as string[]).slice(0, 3).map((t: string) => (
                        <Badge key={t} variant="neutral" className="font-mono text-[10px]">{t}</Badge>
                      ))}
                      {skill.tools.length > 3 && <Badge variant="neutral" className="text-[10px]">+{skill.tools.length - 3}</Badge>}
                    </div>
                  )}
                  {expanded === skill.id ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                </div>
              </div>

              {expanded === skill.id && (
                <div className="border-t border-border bg-muted/10 px-5 py-4 space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Prompt Fragment</p>
                    <pre className="rounded bg-muted px-3 py-2 text-xs whitespace-pre-wrap overflow-x-auto">{skill.prompt_fragment}</pre>
                  </div>
                  {Array.isArray(skill.tools) && skill.tools.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Tools Added</p>
                      <div className="flex flex-wrap gap-1">
                        {(skill.tools as string[]).map((t: string) => (
                          <Badge key={t} variant="neutral" className="font-mono text-xs">{t}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Created {new Date(skill.created_at).toLocaleDateString()} · Version {skill.version}
                  </p>
                  {isAdmin && (
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={() => toggleActive(skill)}>
                        {skill.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
