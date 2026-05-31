'use client';
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { useWorkspace } from '../../../../components/workspace';
import { PageHeader } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input, Select } from '../../../../components/ui/input';
import { Avatar } from '../../../../components/ui/misc';
import { UserPlus } from 'lucide-react';

export default function MembersSettings() {
  const { active } = useWorkspace();
  const [members, setMembers] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('consultant');

  const load = useCallback(async () => {
    if (!active?.id) return;
    setMembers(await api(`/workspaces/${active.id}/members`));
  }, [active?.id]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  async function invite() {
    if (!active?.id || !email) return;
    try { await api(`/workspaces/${active.id}/members`, { method: 'POST', body: JSON.stringify({ email, role }) }); setEmail(''); toast.success('Member added'); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <div>
      <PageHeader title="Members" subtitle="Who can access this workspace and their role." />
      <Card className="mb-5 flex items-end gap-3 p-5">
        <div className="flex-1"><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Invite by email</label><Input placeholder="person@company.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="w-40"><label className="mb-1.5 block text-xs font-medium text-muted-foreground">Role</label>
          <Select value={role} onChange={(e) => setRole(e.target.value)}><option value="admin">Admin</option><option value="manager">Manager</option><option value="consultant">Consultant</option><option value="viewer">Viewer</option></Select>
        </div>
        <Button onClick={invite} disabled={!email}><UserPlus className="size-4" />Add</Button>
      </Card>
      <Card className="divide-y divide-border">
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 px-5 py-3">
            <Avatar name={m.user?.email} />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.user?.display_name}</div><div className="truncate text-xs text-muted-foreground">{m.user?.email}</div></div>
            <Badge variant="neutral" className="capitalize">{m.role}</Badge>
          </div>
        ))}
        {!members.length && <div className="px-5 py-8 text-center text-sm text-muted-foreground">No members.</div>}
      </Card>
    </div>
  );
}
