'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Input, Select, Textarea } from '../../../../components/ui/input';
import { Skeleton } from '../../../../components/ui/skeleton';
import { MailCheck, Save } from 'lucide-react';

interface Account {
  integration_id: string | null;
  account_label: string;
  channel: string;
  mailbox: string | null;
  is_mock: boolean;
  auto_reply_enabled: boolean;
  reply_as_name: string | null;
  reply_as_email: string | null;
  signature: string | null;
  resource_key: string | null;
}

type Form = {
  auto_reply_enabled: boolean;
  reply_as_name: string;
  reply_as_email: string;
  signature: string;
  resource_key: string;
};

const channelLabel = (c: string) =>
  c === 'global' ? 'Global' : c === 'graph_email' ? 'E-posta' : c === 'graph_teams' ? 'Teams' : c === 'whatsapp' ? 'WhatsApp' : c;

export default function ReplyRoutingPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [resources, setResources] = useState<{ key: string; name: string }[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const keyOf = (a: Account) => a.integration_id ?? 'global';

  async function load() {
    const [accts, res] = await Promise.all([
      api('/reply-settings'),
      api('/reply-settings/resources').catch(() => []),
    ]);
    const list: Account[] = accts ?? [];
    setAccounts(list);
    setResources(res ?? []);
    const f: Record<string, Form> = {};
    for (const a of list) {
      f[keyOf(a)] = {
        auto_reply_enabled: a.auto_reply_enabled,
        reply_as_name: a.reply_as_name ?? '',
        reply_as_email: a.reply_as_email ?? '',
        signature: a.signature ?? '',
        resource_key: a.resource_key ?? '',
      };
    }
    setForms(f);
    setLoading(false);
  }
  useEffect(() => { load().catch(() => setLoading(false)); }, []);

  function setField(key: string, field: keyof Form, value: any) {
    setForms((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  }

  async function save(a: Account) {
    const key = keyOf(a);
    const f = forms[key];
    setBusy(key);
    try {
      await api(`/reply-settings/${a.integration_id ?? 'global'}`, {
        method: 'PUT',
        body: JSON.stringify({
          account_label: a.account_label,
          auto_reply_enabled: f.auto_reply_enabled,
          reply_as_name: f.reply_as_name || null,
          reply_as_email: f.reply_as_email || null,
          signature: f.signature || null,
          resource_key: f.resource_key || null,
        }),
      });
      toast.success('Kaydedildi');
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  return (
    <div>
      <PageHeader
        title="Yanıt Kurulumu"
        subtitle="Hangi hesaplara gelenleri yanıtlayacağına ve kim olarak yanıtlayacağına buradan karar ver."
      />

      {loading ? (
        <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : (
        <div className="space-y-4">
          {accounts.map((a) => {
            const key = keyOf(a);
            const f = forms[key];
            if (!f) return null;
            return (
              <Card key={key} className="p-5">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <MailCheck className="size-4 text-muted-foreground" />
                  <span className="font-semibold">{a.account_label}</span>
                  <Badge variant="neutral">{channelLabel(a.channel)}</Badge>
                  {a.mailbox && <span className="text-xs text-muted-foreground">{a.mailbox}</span>}
                  {a.is_mock && <Badge variant="warning">mock</Badge>}
                </div>

                <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[hsl(var(--primary))]"
                    checked={f.auto_reply_enabled}
                    onChange={(e) => setField(key, 'auto_reply_enabled', e.target.checked)}
                  />
                  Bu hesaba gelenleri otomatik yanıtla
                </label>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Yanıt veren ad</label>
                    <Input
                      value={f.reply_as_name}
                      onChange={(e) => setField(key, 'reply_as_name', e.target.value)}
                      placeholder="Örn. Deniz Celan"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Gönderen e-posta</label>
                    <Input
                      value={f.reply_as_email}
                      onChange={(e) => setField(key, 'reply_as_email', e.target.value)}
                      placeholder={a.mailbox ?? 'gonderen@firma.com'}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">İmza</label>
                    <Textarea
                      value={f.signature}
                      onChange={(e) => setField(key, 'signature', e.target.value)}
                      placeholder="Saygılarımla,&#10;Deniz Celan&#10;DynamicsOps"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Yanıtlayan AI kaynağı</label>
                    <Select
                      value={f.resource_key}
                      onChange={(e) => setField(key, 'resource_key', e.target.value)}
                    >
                      <option value="">Varsayılan yönlendirme</option>
                      {resources.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </Select>
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <Button size="sm" disabled={busy === key} onClick={() => save(a)}>
                    <Save className="size-4" />{busy === key ? 'Kaydediliyor…' : 'Kaydet'}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
