'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle, EmptyState } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input, Select } from '../../../../components/ui/input';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Cloud, Plug2, RefreshCw, Trash2, KeyRound } from 'lucide-react';

const KIND_LABEL: Record<string, string> = { bc: 'Business Central', fno: 'Finance & SCM', web: 'Web Uygulaması' };

export default function EnvironmentsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [crypto, setCrypto] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ customer_id: '', kind: 'bc', name: 'Production', base_url: '', tenant_id: '', client_id: '', client_secret: '' });

  const load = useCallback(async () => {
    const [envs, cr, projects] = await Promise.all([
      api('/environments'),
      api('/environments/crypto-status'),
      api('/projects'),
    ]);
    setRows(envs);
    setCrypto(cr);
    // Customer picker from the project portfolio (id + name, deduped).
    const map = new Map<string, string>();
    for (const p of projects as any[]) if (p.customer?.id) map.set(p.customer.id, p.customer.name);
    setCustomers([...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    setLoading(false);
  }, []);
  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  async function create() {
    if (!form.customer_id) { toast.error('Müşteri zorunlu'); return; }
    // Web ortamı Entra app kaydı gerektirmez (erişilebilirlik + bağışlanmış oturum).
    if (form.kind !== 'web' && (!form.tenant_id || !form.client_id)) { toast.error('Tenant ve client ID zorunlu (BC/F&SCM)'); return; }
    if (form.kind === 'web' && !/^https:\/\//.test(form.base_url)) { toast.error('Web uygulaması için https:// ile başlayan URL zorunlu'); return; }
    try {
      await api('/environments', { method: 'POST', body: JSON.stringify(form) });
      toast.success('Ortam eklendi — şimdi Bağlantıyı test edin');
      setForm({ ...form, base_url: '', tenant_id: '', client_id: '', client_secret: '' });
      await load();
    } catch (e: any) { toast.error(e.message); }
  }

  async function probe(id: string) {
    setBusy(id);
    try {
      const r: any = await api(`/environments/${id}/probe`, { method: 'POST' });
      r.ok ? toast.success(r.detail) : toast.error(r.detail);
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  async function rotate(id: string) {
    const s = window.prompt('Yeni client secret:');
    if (!s) return;
    try { await api(`/environments/${id}/secret`, { method: 'POST', body: JSON.stringify({ client_secret: s }) }); toast.success('Secret güncellendi'); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  async function setUiUser(id: string) {
    const u = window.prompt('Ekran görüntüsü servis kullanıcısı (e-posta, MFA\'sız salt-okunur hesap önerilir):');
    if (!u) return;
    const p = window.prompt('Şifresi (şifreli saklanır):');
    if (!p) return;
    try { await api(`/environments/${id}/ui-user`, { method: 'POST', body: JSON.stringify({ ui_user: u, ui_password: p }) }); toast.success('UI kullanıcısı kaydedildi — dokümanlar artık canlı ekran görüntüsü çekebilir'); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  async function remove(id: string) {
    if (!window.confirm('Bu ortam bağlantısı silinsin mi?')) return;
    try { await api(`/environments/${id}`, { method: 'DELETE' }); await load(); }
    catch (e: any) { toast.error(e.message); }
  }

  return (
    <div>
      <PageHeader
        title="Müşteri Ortamları (D365)"
        subtitle="BC ve F&SCM müşteri ortamlarına güvenli otomatik bağlantı — secretlar AES-256-GCM ile şifreli saklanır, salt-okunur keşif yapılır; keşfedilen şirketler doküman üretimini besler."
      />
      {crypto && !crypto.ready && (
        <Card className="mb-4 border-red-500/40 bg-red-500/5 p-4 text-sm">⚠️ {crypto.hint} — secret kaydı bu yapılmadan reddedilir (fail-closed).</Card>
      )}
      {loading ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Card className="p-5">
            <SectionTitle right={<Badge variant="neutral">{rows.length}</Badge>}>Bağlı ortamlar</SectionTitle>
            {!rows.length ? (
              <EmptyState icon={Cloud} title="Henüz ortam yok" hint="Sağdaki formla müşteri BC/F&SCM ortamı ekleyin." />
            ) : (
              <div className="space-y-3">
                {rows.map((r) => {
                  const companies = (r.metadata?.companies ?? []) as any[];
                  return (
                    <div key={r.id} className="rounded-lg border border-border p-3">
                      <div className="flex items-center gap-2">
                        <Badge variant={r.kind === 'bc' ? 'default' : 'outline'}>{KIND_LABEL[r.kind]}</Badge>
                        <span className="font-medium">{customers.find((c) => c.id === r.customer_id)?.name ?? r.customer_id.slice(0, 8)}</span>
                        <span className="text-sm text-muted-foreground">· {r.name}</span>
                        <Badge variant={r.status === 'connected' ? 'success' : r.status === 'error' ? 'danger' : 'neutral'}>{r.status}</Badge>
                        {!r.has_secret && <Badge variant="warning"><KeyRound className="size-3" />secret yok</Badge>}
                        <div className="ml-auto flex gap-1">
                          <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => probe(r.id)}>
                            {busy === r.id ? <RefreshCw className="size-3.5 animate-spin" /> : <Plug2 className="size-3.5" />} Bağlantıyı test et
                          </Button>
                          <Button size="sm" variant={r.has_ui_user ? 'ghost' : 'outline'} title="Ekran görüntüsü UI kullanıcısı" onClick={() => setUiUser(r.id)}>🖥{r.has_ui_user ? '' : ' UI kullanıcısı'}</Button>
                          <Button size="sm" variant="ghost" title="Secret döndür" onClick={() => rotate(r.id)}><KeyRound className="size-3.5" /></Button>
                          <Button size="sm" variant="ghost" title="Sil" onClick={() => remove(r.id)}><Trash2 className="size-3.5" /></Button>
                        </div>
                      </div>
                      <div className="mt-1.5 text-xs text-muted-foreground">
                        {r.kind === 'bc' ? `environment: ${r.base_url || 'Production'}` : (r.base_url ?? 'url girilmedi')}{r.kind !== 'web' && ` · tenant ${String(r.tenant_id).slice(0, 8)}…`}
                        {r.last_probe_at && ` · son test: ${new Date(r.last_probe_at).toLocaleString('tr-TR')}`}
                      </div>
                      {companies.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {companies.slice(0, 8).map((c: any) => <Badge key={c.id ?? c.name} variant="outline">{c.name}</Badge>)}
                          {companies.length > 8 && <Badge variant="neutral">+{companies.length - 8}</Badge>}
                        </div>
                      )}
                      {((r.metadata?.extensions ?? []) as any[]).length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Yüklü uzantılar</span>
                          {(r.metadata.extensions as any[]).slice(0, 6).map((x: any, i: number) => (
                            <Badge key={i} variant="neutral">{x.displayName}{x.publisher ? ` · ${x.publisher}` : ''}</Badge>
                          ))}
                          {(r.metadata.extensions as any[]).length > 6 && <Badge variant="neutral">+{(r.metadata.extensions as any[]).length - 6}</Badge>}
                        </div>
                      )}
                      {r.last_error && <p className="mt-2 text-xs text-red-500">{r.last_error}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="h-fit p-5">
            <SectionTitle>Yeni ortam ekle</SectionTitle>
            <div className="grid gap-2.5">
              <Select value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })}>
                <option value="">— müşteri seç —</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="bc">D365 Business Central</option>
                <option value="fno">D365 Finance & SCM</option>
                <option value="web">Web Uygulaması</option>
              </Select>
              <Input placeholder="Ortam adı (Production / UAT)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input placeholder={form.kind === 'bc' ? 'BC environment adı (örn. Production)' : form.kind === 'web' ? 'Uygulama URL (https://app.musteri.com)' : 'F&O URL (https://xxx.operations.dynamics.com)'} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
              {form.kind !== 'web' && (<>
                <Input placeholder="Entra Tenant ID" value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })} />
                <Input placeholder="Client (App) ID" value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
                <Input type="password" placeholder="Client Secret (şifreli saklanır)" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
              </>)}
              <Button onClick={create}>Ekle</Button>
              <p className="text-xs text-muted-foreground">
                Gerekli izinler: BC → Entra app + BC admin&apos;de kayıt (API.ReadWrite.All app izni, D365 tarafında salt-okunur rol önerilir);
                F&SCM → Entra app + System administration &gt; Microsoft Entra applications kaydı. Ayrıntı: infra/customer-environments-setup.md
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
