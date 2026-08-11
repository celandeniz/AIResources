'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, apiStreamUrl } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader, SectionTitle, ChannelChip, StatusBadge } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Skeleton } from '../../../../components/ui/skeleton';
import { Input, Select, Textarea } from '../../../../components/ui/input';
import { Sheet, SheetContent, SheetTrigger } from '../../../../components/ui/sheet';
import { KpiCard } from '../../../../components/charts';
import { ExternalLink, Settings2, ClipboardCheck, Target } from 'lucide-react';

const HEALTH_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  green: 'success', amber: 'warning', red: 'danger',
};

const BUCKETS: { key: string; label: string; tone: 'danger' | 'warning' | 'default' | 'neutral' }[] = [
  { key: 'overdue', label: 'Gecikmiş', tone: 'danger' },
  { key: 'this_week', label: 'Bu hafta', tone: 'warning' },
  { key: 'next_week', label: 'Gelecek hafta', tone: 'default' },
  { key: 'this_month', label: 'Bu ay', tone: 'neutral' },
  { key: 'undated', label: 'Açık işler (tarihsiz)', tone: 'neutral' },
];

export default function ProjectDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [documentsRevision, setDocumentsRevision] = useState(0);
  const [editDocumentId, setEditDocumentId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api(`/projects/${id}/dashboard`));
    setLoading(false);
  }, [id]);

  const documentChanged = useCallback((docId?: string, edit = false) => {
    setDocumentsRevision((revision) => revision + 1);
    if (docId && edit) setEditDocumentId(docId);
  }, []);

  useEffect(() => { load().catch(() => setLoading(false)); }, [load]);

  // Realtime: SSE project events + 15s poll fallback while the page is open.
  useEffect(() => {
    const es = new EventSource(apiStreamUrl('/stream'));
    const onEvent = () => load().catch(() => {});
    es.addEventListener('project', onEvent);
    es.addEventListener('coverage', onEvent);
    const t = setInterval(onEvent, 15000);
    return () => { es.close(); clearInterval(t); };
  }, [load]);

  async function createStatusReport() {
    const p = data?.project;
    try {
      const now = new Date();
      const from = new Date(now.getTime() - 14 * 86400000);
      const row: any = await api('/status-reports', {
        method: 'POST',
        body: JSON.stringify({
          customerId: (p?.metadata as any)?.cosmos_customer_id ?? p?.customer?.id,
          projectLabel: p?.cosmos_project_name ?? p?.name,
          from: from.toISOString().slice(0, 10),
          to: now.toISOString().slice(0, 10),
          sources: { devops: true, outlook: true, teams: Boolean(p?.teams_team_id) },
          keywords: (p?.mail_keywords as string[]) ?? [],
        }),
      });
      router.push(`/status-reports/${row.id}`);
    } catch (e: any) { toast.error(e.message); }
  }

  if (loading) return <div className="space-y-4"><Skeleton className="h-20" /><Skeleton className="h-64" /></div>;
  if (!data?.project) return <div className="text-sm text-muted-foreground">Proje bulunamadı.</div>;

  const p = data.project;
  const k = data.kpis ?? {};
  const buckets = data.buckets ?? {};

  return (
    <div>
      <PageHeader
        title={p.name}
        subtitle={[p.customer?.name, p.devops_org && p.devops_project ? `ADO: ${p.devops_org}/${p.devops_project}` : null, p.teams_team_id ? 'Teams bağlı' : null].filter(Boolean).join(' · ')}
        actions={
          <>
            <StackBadges p={p} />
            {data.health && <Badge variant={HEALTH_VARIANT[data.health] ?? 'neutral'}>{data.health}</Badge>}
            <Button variant="outline" onClick={createStatusReport}><ClipboardCheck className="size-4" /> Durum raporu oluştur</Button>
            <MappingsSheet p={p} onSaved={load} />
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard label="Açık işler" value={k.openItems ?? 0} accent="primary" sub="tüm kanallar" />
        <KpiCard label="Gecikmiş" value={k.overdue ?? 0} accent="warning" sub="SLA geçti" />
        <KpiCard label="Takipsiz konu" value={k.stalledThreads ?? 0} accent="warning" sub="coverage watchdog" />
        <KpiCard label="Aktif mission" value={k.runningMissions ?? 0} accent="success" sub="pod çalışıyor" />
        <KpiCard label="Bekleyen onay" value={k.pendingApprovals ?? 0} accent="primary" sub="Approval Center" />
      </div>

      <RoleBrief projectId={String(id)} brief={data.brief} onGenerated={load} />

      <StoryAudit
        projectId={String(id)}
        audit={(data.project?.metadata as any)?.story_audit}
        adoOrg={p.devops_org}
        adoProject={p.devops_project}
        onDone={load}
        onDocumentChanged={documentChanged}
      />

      <DocumentLibrary
        projectId={String(id)}
        revision={documentsRevision}
        editDocumentId={editDocumentId}
        onEditConsumed={() => setEditDocumentId(null)}
        onChanged={() => documentChanged()}
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-5">
          {Object.keys(data.adoByState ?? {}).length > 0 && (
            <Card className="p-5">
              <SectionTitle>ADO durum dağılımı</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {Object.entries(data.adoByState as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([state, n]) => (
                  <Badge key={state} variant={/new|to do|proposed/i.test(state) ? 'warning' : /active|doing|progress/i.test(state) ? 'default' : 'neutral'}>{state}: {n}</Badge>
                ))}
              </div>
            </Card>
          )}
          {BUCKETS.map((b) => (
            <Card key={b.key} className="p-5">
              <SectionTitle right={<Badge variant={b.tone === 'danger' ? 'danger' : b.tone === 'warning' ? 'warning' : 'neutral'}>{(buckets[b.key] ?? []).length}</Badge>}>
                {b.label}
              </SectionTitle>
              {(buckets[b.key] ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Bu pencerede iş yok.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {(buckets[b.key] ?? []).slice(0, b.key === 'undated' ? 30 : 12).map((item: any) => <BucketRow key={`${item.kind}-${item.id}`} item={item} />)}
                </ul>
              )}
            </Card>
          ))}
        </div>

        <div className="space-y-5">
          {data.statusReport && (
            <Card className="p-5">
              <SectionTitle>Son durum raporu</SectionTitle>
              <div className="flex items-center justify-between text-sm">
                <span>{data.statusReport.period_label}</span>
                <Badge variant={HEALTH_VARIANT[data.statusReport.health] ?? 'neutral'}>{data.statusReport.health ?? '—'}</Badge>
              </div>
              <Link className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline" href={`/status-reports/${data.statusReport.id}`}>
                Raporu aç <ExternalLink className="size-3" />
              </Link>
            </Card>
          )}
          <Card className="p-5">
            <SectionTitle>Aktif missionlar</SectionTitle>
            {(data.missions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Aktif mission yok.</p>
            ) : (
              <ul className="space-y-2">
                {data.missions.map((m: any) => (
                  <li key={m.id}>
                    <Link href={`/missions/${m.id}`} className="flex items-center gap-2 text-sm hover:underline">
                      <Target className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{m.title}</span>
                      <Badge variant={m.status === 'blocked' ? 'danger' : 'default'}>{m.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-5">
            <SectionTitle>Canlı akış</SectionTitle>
            <ul className="space-y-2.5">
              {(data.feed ?? []).map((a: any) => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  <ChannelChip channel={a.channel} />
                  <Link href={`/inbox/${a.id}`} className="min-w-0 flex-1 truncate hover:underline">{a.subject ?? '(konu yok)'}</Link>
                  <StatusBadge status={a.status} />
                </li>
              ))}
              {!(data.feed ?? []).length && <p className="text-sm text-muted-foreground">Henüz aktivite yok.</p>}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

// Tech-stack chips (WS6): declared repo kinds + ISV count on the header.
const STACK_LABEL: Record<string, string> = { 'bc-al': 'BC', 'fno-xpp': 'F&SCM', web: 'Web' };
function StackBadges({ p }: { p: any }) {
  const kinds = [...new Set(((p.repos as any[]) ?? []).map((r: any) => STACK_LABEL[r.kind] ?? r.kind))];
  const isvCount = ((p.isvs as any[]) ?? []).length;
  if (!kinds.length && !isvCount) return null;
  return (
    <span className="flex items-center gap-1.5">
      {kinds.map((k) => <Badge key={k} variant="outline">{k}</Badge>)}
      {isvCount > 0 && <Badge variant="neutral">{isvCount} ISV</Badge>}
    </span>
  );
}

// Enrichment draft → editable review state. The non-editable parts (business
// value, out-of-scope, open questions, suggested tasks) ride along so the panel
// can show WHY the description reads the way it does.
function fillFromDraft(wid: string, title: string | undefined, draft: any, context?: any, docId?: string) {
  return {
    storyId: wid,
    title,
    docId,
    context,
    description: draft?.description ?? '',
    acceptance: (draft?.acceptance ?? []).join('\n'),
    businessValue: draft?.business_value ?? '',
    scopeOut: draft?.scope_out ?? [],
    openQuestions: draft?.open_questions ?? [],
    suggestedTasks: draft?.suggested_tasks ?? [],
  };
}

// Bulk enrichment: the sweep runs server-side (each story is a ~1-2 min model
// call), so this only starts it and follows progress, listing each finished
// draft for one-by-one review.
function BulkEnrich({ projectId, weak, states, onPick }: { projectId: string; weak: number; states: string[]; onPick: (d: any) => void }) {
  const [state, setState] = useState<any>(null);
  const [starting, setStarting] = useState(false);

  const poll = useCallback(async () => {
    try { setState(await api(`/projects/${projectId}/enrich-run`)); } catch { /* geçici */ }
  }, [projectId]);

  useEffect(() => { poll(); }, [poll]);
  // Only poll while a sweep is actually in flight.
  useEffect(() => {
    if (!state?.run || state.run.finishedAt) return;
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [state?.run?.finishedAt, state?.run, poll]);

  async function start() {
    setStarting(true);
    try {
      // The sweep targets exactly what the status filter selected.
      const r: any = await api(`/projects/${projectId}/stories/enrich-bulk`, { method: 'POST', body: JSON.stringify({ limit: 10, states }) });
      if (!r?.ok) throw new Error(r?.detail ?? 'başlatılamadı');
      toast.success(r.detail);
      await poll();
    } catch (e: any) { toast.error(e.message); } finally { setStarting(false); }
  }

  const run = state?.run;
  const drafts: any[] = state?.drafts ?? [];
  const active = run && !run.finishedAt;
  return (
    <div className="mb-4 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">🤖 Toplu story geliştirme</span>
        <span className="text-xs text-muted-foreground">
          {states.length ? <>Seçili durum ({states.join(', ')}) içinde </> : null}
          {weak} story 50 puanın altında — Epic/Feature + proje amacı + ürün yığınından geliştirilir.
        </span>
        <Button size="sm" className="ml-auto" onClick={start} disabled={starting || active}>
          {active ? `Çalışıyor… ${run.done}/${run.total}` : starting ? 'Başlatılıyor…' : `En zayıf ${Math.min(weak, 10)} story’yi geliştir`}
        </Button>
      </div>
      {run && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {active ? '⏳ arka planda çalışıyor' : '✅ tamamlandı'} · {run.done}/{run.total} işlendi · {run.drafts?.length ?? 0} taslak hazır
          {run.failed > 0 && ` · ${run.failed} başarısız`}
        </p>
      )}
      {drafts.length > 0 && (
        <ul className="mt-2 divide-y divide-border">
          {drafts.map((d) => (
            <li key={d.docId} className="flex items-center gap-2 py-1.5 text-sm">
              <Badge variant="outline">#{d.wid}</Badge>
              <span className="min-w-0 flex-1 truncate">{d.story?.title ?? d.title}</span>
              {d.previousScore != null && <Badge variant="danger">{d.previousScore}/100</Badge>}
              <Button size="sm" variant="outline" onClick={() => onPick(d)}>İncele</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StoryAudit({ projectId, audit, adoOrg, adoProject, onDone, onDocumentChanged }: {
  projectId: string;
  audit: any;
  adoOrg?: string;
  adoProject?: string;
  onDone: () => void;
  onDocumentChanged: (docId?: string, edit?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [docBusy, setDocBusy] = useState<string | null>(null);
  const [planView, setPlanView] = useState<any>(null); // {storyId, planDocId, plan, story}
  const [planSaving, setPlanSaving] = useState(false);
  const [docRunView, setDocRunView] = useState<any>(null); // {storyId, title, run}
  const [fill, setFill] = useState<any>(null); // {storyId, title, description, acceptance}
  const [selectedStates, setSelectedStates] = useState<string[]>([]); // boş = tümü
  const notifiedRuns = useRef(new Set<string>());

  async function run() {
    setBusy(true);
    try {
      const r: any = await api(`/projects/${projectId}/story-audit`, { method: 'POST' });
      if (!r?.ok) throw new Error(r?.detail ?? 'analiz başarısız');
      toast.success(`${r.total} user story puanlandı — ort. ${r.avgScore}/100, ${r.docMissing} dokümansız`);
      onDone();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }

  // Phase 1: readiness pre-analysis + plan. If content/environment isn't
  // sufficient, the system does NOT generate — it shows what's missing and
  // exactly where to fill it.
  async function startDocBuild(wid: string, planDocId: string, title?: string) {
    const r: any = await api(`/projects/${projectId}/stories/${wid}/doc`, {
      method: 'POST',
      body: JSON.stringify({ deliver: true, planDocId }),
    });
    if (!r?.ok || !r?.started) throw new Error(r?.detail ?? 'doküman üretimi başlatılamadı');
    setDocRunView({
      storyId: wid,
      title,
      run: { runId: r.runId, phase: 'running', section: 0, totalSections: 0, sectionName: 'Hazırlanıyor' },
    });
    setPlanView(null);
    toast.success('Doküman bölüm hattı başlatıldı');
  }

  async function makePlan(wid: string, force = false, autoGenerate = false) {
    setDocBusy(wid);
    setPlanView(null);
    try {
      const r: any = await api(`/projects/${projectId}/stories/${wid}/doc-plan`, { method: 'POST', body: JSON.stringify({ force }) });
      if (!r?.ok) throw new Error(r?.detail ?? 'plan üretilemedi');
      if (r.ready === false) {
        setPlanView({ storyId: wid, notReady: true, checks: r.checks, story: r.story, children: r.children });
        return;
      }
      const nextPlan = { storyId: wid, planDocId: r.planDocId, plan: r.plan, story: r.story, checks: r.checks, children: r.children };
      const hasBlocker = (r.checks ?? []).some((check: any) => check.blocker && !check.ok);
      const exampleCheck = (r.checks ?? []).find((check: any) => check.key === 'ornek_kayit');
      if (autoGenerate && r.ready === true && !hasBlocker && exampleCheck?.ok) {
        await startDocBuild(wid, r.planDocId, r.story?.title);
      } else {
        setPlanView(nextPlan);
      }
    } catch (e: any) { toast.error(e.message); } finally { setDocBusy(null); }
  }

  const pollDocRun = useCallback(async (storyId: string, expectedRunId?: string) => {
    try {
      const response: any = await api(`/projects/${projectId}/stories/${storyId}/doc-run`);
      const nextRun = response?.run ?? response;
      if (!nextRun || response?.ok === false) return;
      if (expectedRunId && nextRun.runId && String(nextRun.runId) !== String(expectedRunId)) return;
      if (response.docId && !nextRun.docId) nextRun.docId = response.docId;
      if (response.htmlPath && !nextRun.htmlPath) nextRun.htmlPath = response.htmlPath;
      if (response.pdfPath && !nextRun.pdfPath) nextRun.pdfPath = response.pdfPath;
      setDocRunView((current: any) => ({ ...current, storyId, run: nextRun }));
      const runId = String(nextRun.runId ?? '');
      if (nextRun.phase === 'done' && runId && !notifiedRuns.current.has(runId)) {
        notifiedRuns.current.add(runId);
        toast.success('Doküman hazır — HTML ve PDF çıktıları açılabilir');
        onDocumentChanged(nextRun.docId ?? response.docId);
        onDone();
      } else if (nextRun.phase === 'failed' && runId && !notifiedRuns.current.has(runId)) {
        notifiedRuns.current.add(runId);
        toast.error(nextRun.error || 'Doküman koşusu başarısız oldu');
      }
    } catch { /* detached koşu sürerken geçici ağ hatasını bir sonraki turda yeniden dene */ }
  }, [onDocumentChanged, onDone, projectId]);

  useEffect(() => {
    const run = docRunView?.run;
    if (!docRunView?.storyId || run?.phase !== 'running') return;
    const expectedRunId = run.runId ? String(run.runId) : undefined;
    void pollDocRun(docRunView.storyId, expectedRunId);
    const timer = setInterval(() => { void pollDocRun(docRunView.storyId, expectedRunId); }, 3000);
    return () => clearInterval(timer);
  }, [docRunView?.run?.phase, docRunView?.run?.runId, docRunView?.storyId, pollDocRun]);

  // Story Geliştirme Asistanı: develops the story from its Epic/Feature, the
  // project purpose and the product stack. The user edits, then explicitly
  // writes to ADO (button = human approval); the readiness pre-analysis
  // re-runs automatically afterwards.
  async function enrichStory(wid: string) {
    setDocBusy(wid);
    try {
      const r: any = await api(`/projects/${projectId}/stories/${wid}/enrich`, { method: 'POST' });
      if (!r?.ok) throw new Error(r?.detail ?? 'taslak üretilemedi');
      setFill(fillFromDraft(wid, r.story?.title, r.draft, r.context));
    } catch (e: any) { toast.error(e.message); } finally { setDocBusy(null); }
  }
  async function applyFill() {
    if (!fill) return;
    setDocBusy(fill.storyId);
    try {
      const r: any = await api(`/projects/${projectId}/stories/${fill.storyId}/apply-content`, {
        method: 'POST',
        body: JSON.stringify({
          description: fill.description,
          acceptance: String(fill.acceptance ?? '').split('\n').map((s: string) => s.trim()).filter(Boolean),
          ...(fill.docId ? { docId: fill.docId } : {}),
        }),
      });
      if (!r?.ok) throw new Error(r?.detail ?? 'ADO yazımı başarısız');
      toast.success(`#${fill.storyId} içeriği ADO'ya yazıldı — ön analiz yeniden çalışıyor`);
      const wid = fill.storyId;
      setFill(null);
      await makePlan(wid);
    } catch (e: any) { toast.error(e.message); } finally { setDocBusy(null); }
  }

  // Phase 2: approve → execute exactly the plan.
  async function approveAndGenerate() {
    if (!planView) return;
    setDocBusy(planView.storyId);
    try {
      await startDocBuild(planView.storyId, planView.planDocId, planView.story?.title);
    } catch (e: any) { toast.error(e.message); } finally { setDocBusy(null); }
  }

  function updatePlanMeta(key: string, value: string) {
    setPlanView((current: any) => current ? {
      ...current,
      plan: { ...current.plan, meta: { ...(current.plan?.meta ?? {}), [key]: value } },
    } : current);
  }

  async function savePlanMeta() {
    if (!planView?.planDocId) return;
    setPlanSaving(true);
    try {
      const meta = planView.plan?.meta ?? {};
      const response: any = await api(`/projects/${projectId}/stories/${planView.storyId}/doc-plan`, {
        method: 'PATCH',
        body: JSON.stringify({
          planDocId: planView.planDocId,
          meta: {
            tur: meta.tur || 'egitim',
            hedef_kitle: meta.hedef_kitle || 'Son kullanıcı',
            ornek_kayit: meta.ornek_kayit || '',
            surum: meta.surum || '1.0',
          },
        }),
      });
      if (!response?.ok) throw new Error(response?.detail ?? 'plan bilgileri kaydedilemedi');
      setPlanView((current: any) => ({
        ...current,
        planDocId: response.planDocId ?? current.planDocId,
        plan: response.plan ?? current.plan,
        checks: response.checks ?? current.checks,
      }));
      toast.success('Doküman şablonu ve meta bilgileri kaydedildi');
    } catch (e: any) { toast.error(e.message); } finally { setPlanSaving(false); }
  }

  const allRows: any[] = audit?.rows ?? [];
  // Status filter: pick the ADO states the AI should act on. It drives BOTH the
  // table and the bulk sweep — filtering the view without filtering the action
  // would make "enrich the New ones" impossible to express.
  const stateCounts = allRows.reduce((acc: Record<string, number>, r) => {
    const s = String(r.state || '—');
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const states = Object.keys(stateCounts).sort((a, b) => stateCounts[b] - stateCounts[a]);
  const rows = selectedStates.length ? allRows.filter((r) => selectedStates.includes(String(r.state || '—'))) : allRows;
  const weak = rows.filter((r) => Number(r.score ?? 0) < 50).length;
  const toggleState = (s: string) =>
    setSelectedStates((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  return (
    <Card className="mt-6 p-5">
      <SectionTitle right={
        <div className="flex items-center gap-2">
          {audit?.at && <span className="text-xs text-muted-foreground">{new Date(audit.at).toLocaleString('tr-TR')}</span>}
          {audit && <Badge variant={audit.avgScore >= 70 ? 'success' : audit.avgScore >= 50 ? 'warning' : 'danger'}>ort. {audit.avgScore}/100</Badge>}
          {audit && audit.docMissing > 0 && <Badge variant="warning">{audit.docMissing} dokümansız</Badge>}
          <Button size="sm" variant="outline" onClick={run} disabled={busy}>{busy ? 'Analiz ediliyor…' : audit ? 'Yeniden analiz et' : 'User story analizi'}</Button>
        </div>
      }>User Story Kalitesi &amp; Dokümantasyon</SectionTitle>
      {allRows.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Durum:</span>
          <button
            type="button"
            onClick={() => setSelectedStates([])}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${!selectedStates.length ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50'}`}
          >
            Tümü ({allRows.length})
          </button>
          {states.map((s) => {
            const on = selectedStates.includes(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleState(s)}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50'}`}
              >
                {s} ({stateCounts[s]})
              </button>
            );
          })}
          {selectedStates.length > 0 && (
            <span className="ml-1 text-xs text-muted-foreground">
              → {rows.length} story seçili{weak > 0 ? `, ${weak} tanesi zayıf` : ''}
            </span>
          )}
        </div>
      )}
      {weak > 0 && (
        <BulkEnrich
          projectId={projectId}
          weak={weak}
          states={selectedStates}
          onPick={(d: any) => setFill(fillFromDraft(d.wid, d.story?.title, d.draft, d.context, d.docId))}
        />
      )}
      {docRunView?.run && (
        <div className={`mb-4 overflow-hidden rounded-lg border p-4 ${docRunView.run.phase === 'failed' ? 'border-red-500/40 bg-red-500/5' : docRunView.run.phase === 'done' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-primary/40 bg-primary/5'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">
                  {docRunView.run.phase === 'done' ? '✅ Doküman hazır' : docRunView.run.phase === 'failed' ? '⛔ Doküman koşusu durdu' : '📄 Doküman hazırlanıyor'}
                </span>
                <Badge variant="outline">#{docRunView.storyId}</Badge>
                {docRunView.title && <span className="truncate text-sm text-muted-foreground">{docRunView.title}</span>}
              </div>
              {docRunView.run.phase === 'running' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Bölüm {docRunView.run.section ?? 0}/{docRunView.run.totalSections || '…'} üretiliyor…
                  {docRunView.run.sectionName ? ` (${docRunView.run.sectionName})` : ''}
                </p>
              )}
              {docRunView.run.phase === 'failed' && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{docRunView.run.error || 'Koşu tamamlanamadı.'}</p>}
              {docRunView.run.phase === 'done' && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {docRunView.run.screenshots ?? 0} ekran görüntüsü · {docRunView.run.totalSections ?? docRunView.run.sections?.length ?? 0} bölüm
                </p>
              )}
            </div>
            {docRunView.run.phase === 'done' && (
              <div className="flex flex-wrap gap-2">
                {docRunView.run.htmlPath && (
                  <Button asChild size="sm" variant="outline">
                    <a href={apiStreamUrl(docRunView.run.htmlPath)} target="_blank" rel="noreferrer">HTML aç</a>
                  </Button>
                )}
                {docRunView.run.pdfPath && (
                  <Button asChild size="sm" variant="outline">
                    <a href={apiStreamUrl(docRunView.run.pdfPath)} target="_blank" rel="noreferrer" download>PDF indir</a>
                  </Button>
                )}
                {docRunView.run.docId && (
                  <Button size="sm" onClick={() => onDocumentChanged(docRunView.run.docId, true)}>Düzenle</Button>
                )}
              </div>
            )}
          </div>
          {docRunView.run.phase === 'running' && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-primary/10" role="progressbar" aria-valuemin={0} aria-valuemax={docRunView.run.totalSections || 1} aria-valuenow={docRunView.run.section || 0}>
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${docRunView.run.totalSections ? Math.max(4, Math.min(100, (Number(docRunView.run.section ?? 0) / Number(docRunView.run.totalSections)) * 100)) : 4}%` }}
              />
            </div>
          )}
        </div>
      )}
      {planView?.notReady && (
        <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">⚠️ Ön Analiz — #{planView.story?.id} doküman üretimine hazır değil</span>
            <div className="flex gap-2">
              {(planView.checks ?? []).some((c: any) => c.key === 'icerik' && !c.ok) && (
                <Button size="sm" onClick={() => enrichStory(planView.storyId)} disabled={docBusy === planView.storyId}>
                  {docBusy === planView.storyId ? 'Taslak hazırlanıyor…' : '✍️ AI ile doldur'}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => makePlan(planView.storyId, true)} disabled={docBusy === planView.storyId}>
                {docBusy === planView.storyId ? 'Hazırlanıyor…' : 'Yine de üret (zorla)'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPlanView(null)}>Kapat</Button>
            </div>
          </div>
          <ul className="space-y-2 text-sm">
            {(planView.checks ?? []).map((c: any) => (
              <li key={c.key} className="flex items-start gap-2">
                <span>{c.ok ? '✅' : c.blocker ? '⛔' : '⚠️'}</span>
                <div className="min-w-0">
                  <span>{c.message}</span>
                  {c.fix && (
                    <div className="mt-0.5 text-xs">
                      → {c.fix.url?.startsWith('http')
                        ? <a className="text-primary underline" href={c.fix.url} target="_blank" rel="noreferrer">{c.fix.label}</a>
                        : c.fix.url?.startsWith('/')
                          ? <Link className="text-primary underline" href={c.fix.url}>{c.fix.label}</Link>
                          : c.fix.url?.startsWith('#')
                            ? <a className="text-primary underline" href={c.fix.url}>{c.fix.label}</a>
                            : <code>{c.fix.label}</code>}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {(planView.children ?? []).length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">Alt görevler ({planView.children.length}): {planView.children.map((c: any) => `#${c.id}`).join(', ')} — açıklamaları da içerik sayılır.</p>
          )}
        </div>
      )}
      {fill && (
        <div className="mb-4 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">✍️ Story Geliştirme Taslağı — #{fill.storyId} {fill.title}</span>
            <div className="flex gap-2">
              <Button size="sm" onClick={applyFill} disabled={docBusy === fill.storyId}>
                {docBusy === fill.storyId ? 'Yazılıyor…' : "✅ Onayla ve ADO'ya yaz"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFill(null)}>Vazgeç</Button>
            </div>
          </div>
          {/* Which upstream context actually shaped this draft — a missing Epic
              link or an unset purpose is usually the real reason output is thin. */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            {(fill.context?.ancestors ?? []).map((a: any) => (
              <Badge key={a.id} variant="outline">{a.type} #{a.id}: {String(a.title).slice(0, 40)}</Badge>
            ))}
            {!(fill.context?.ancestors ?? []).length && <Badge variant="warning">Epic/Feature bağlantısı yok — üst bağlam kullanılamadı</Badge>}
            <Badge variant={fill.context?.hasPurpose ? 'success' : 'warning'}>{fill.context?.hasPurpose ? 'proje amacı ✓' : 'proje amacı girilmemiş'}</Badge>
            <Badge variant={fill.context?.hasStack ? 'success' : 'neutral'}>{fill.context?.hasStack ? 'ürün yığını ✓' : 'ürün yığını yok'}</Badge>
            {fill.context?.children > 0 && <Badge variant="neutral">{fill.context.children} alt görev</Badge>}
          </div>
          <p className="mb-2 text-xs text-muted-foreground">Taslağı düzenleyin; &quot;Onayla&quot; ile açıklama + kabul kriterleri ADO iş kalemine yazılır ve ön analiz otomatik tekrarlanır. Onaylamadan hiçbir şey yazılmaz.</p>
          {fill.businessValue && (
            <p className="mb-2 rounded bg-background/60 p-2 text-xs"><strong>İş değeri:</strong> {fill.businessValue}</p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Açıklama</label>
              <textarea
                className="h-48 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={fill.description}
                onChange={(e) => setFill({ ...fill, description: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Kabul kriterleri (her satır bir madde)</label>
              <textarea
                className="h-48 w-full rounded-md border border-border bg-background p-2 text-sm"
                value={fill.acceptance}
                onChange={(e) => setFill({ ...fill, acceptance: e.target.value })}
              />
            </div>
          </div>
          {/* Analyst-side output: not written to ADO, but what a consultant
              needs to act on before the story is truly ready. */}
          {(fill.scopeOut?.length || fill.openQuestions?.length || fill.suggestedTasks?.length) ? (
            <div className="mt-3 grid gap-3 text-xs md:grid-cols-3">
              {fill.scopeOut?.length > 0 && (
                <div><p className="mb-1 font-medium text-muted-foreground">Kapsam dışı</p>
                  <ul className="ml-4 list-disc space-y-0.5">{fill.scopeOut.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul></div>
              )}
              {fill.openQuestions?.length > 0 && (
                <div><p className="mb-1 font-medium text-amber-500">❓ Müşteriye sorulacaklar</p>
                  <ul className="ml-4 list-disc space-y-0.5">{fill.openQuestions.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul></div>
              )}
              {fill.suggestedTasks?.length > 0 && (
                <div><p className="mb-1 font-medium text-muted-foreground">Önerilen alt görevler</p>
                  <ul className="ml-4 list-disc space-y-0.5">{fill.suggestedTasks.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
                  <p className="mt-1 text-[11px] text-muted-foreground">(öneri — ADO&apos;ya otomatik açılmaz)</p></div>
              )}
            </div>
          ) : null}
        </div>
      )}
      {planView && !planView.notReady && (
        <div className="mb-4 rounded-lg border border-primary/40 bg-primary/5 p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-semibold">📋 Doküman Planı — #{planView.story?.id} {planView.story?.title}</span>
            <div className="flex gap-2">
              <Button size="sm" onClick={approveAndGenerate} disabled={docBusy === planView.storyId}>
                {docBusy === planView.storyId ? 'Üretiliyor…' : '✅ Onayla ve Üret'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPlanView(null)}>İptal</Button>
            </div>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Şablon ve teslimat bilgisini netleştirin. Uyarılar üretimi engellemez; somut örnek kayıt tek tık üretimi etkinleştirir.
            {(planView.children ?? []).length > 0 && ` ${planView.children.length} alt görev kaynak olarak kullanılacak.`}
          </p>
          <div id="doc-plan-meta" className="mb-4 scroll-mt-24 rounded-md border border-border/80 bg-background/60 p-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Şablon">
                <Select
                  value={planView.plan?.meta?.tur ?? 'egitim'}
                  onChange={(e) => updatePlanMeta('tur', e.target.value)}
                >
                  <option value="egitim">Eğitim</option>
                  <option value="surec">Süreç</option>
                  <option value="kullanim">Kullanım kılavuzu</option>
                </Select>
              </Field>
              <Field label="Hedef kitle">
                <Select
                  value={planView.plan?.meta?.hedef_kitle ?? 'Son kullanıcı'}
                  onChange={(e) => updatePlanMeta('hedef_kitle', e.target.value)}
                >
                  <option value="Son kullanıcı">Son kullanıcı</option>
                  <option value="Süper kullanıcı">Süper kullanıcı</option>
                  <option value="Süreç sahibi">Süreç sahibi</option>
                  <option value="Teknik ekip">Teknik ekip</option>
                </Select>
              </Field>
              <Field label="Örnek kayıt">
                <Input
                  value={planView.plan?.meta?.ornek_kayit ?? ''}
                  onChange={(e) => updatePlanMeta('ornek_kayit', e.target.value)}
                  placeholder="Örn. SO-10428 / Contoso"
                />
              </Field>
              <Field label="Sürüm">
                <Input
                  value={planView.plan?.meta?.surum ?? '1.0'}
                  onChange={(e) => updatePlanMeta('surum', e.target.value)}
                  placeholder="1.0"
                />
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="outline" onClick={savePlanMeta} disabled={planSaving}>
                {planSaving ? 'Kaydediliyor…' : 'Kaydet'}
              </Button>
            </div>
          </div>
          <ReadinessChecklist checks={planView.checks ?? []} />
          <div className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <p><span className="text-muted-foreground">Platform:</span> <strong>{planView.plan.platform}</strong></p>
              <p><span className="text-muted-foreground">Ortam:</span> {planView.plan.ortam ?? '—'}</p>
              <p><span className="text-muted-foreground">Oturum/Kullanıcı:</span> {planView.plan.oturum?.label}</p>
              <p><span className="text-muted-foreground">Modül:</span> {planView.plan.modul ?? '—'} · <span className="text-muted-foreground">Şirket:</span> <strong>{planView.plan.sirket ?? '—'}</strong></p>
              {planView.plan.assist_needed && (
                <p className="mt-2 rounded bg-amber-500/10 p-2 text-xs">⚠️ Ekran görüntüleri için yetkilendirme gerekli: <code>{planView.plan.assist_hint}</code></p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">Çekilecek ekranlar:</p>
              <ul className="ml-4 list-disc">
                {(planView.plan.ekranlar ?? []).map((e: any, i: number) => (
                  <li key={i}>
                    {e.caption}{' '}
                    <code className="text-xs">
                      [{e.platform === 'bc' ? 'BC' : e.platform === 'web' ? 'Web' : 'F&SCM'}] ({e.platform === 'bc' ? `sayfa ${e.page} · ${e.company ?? ''}` : e.platform === 'web' ? e.path : `${e.mi} · ${e.cmp}`})
                    </code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-muted-foreground">Yöntem:</p>
              <ul className="ml-4 list-disc">{(planView.plan.yontem ?? []).map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>
            </div>
            <div>
              <p className="text-muted-foreground">Veri seti:</p>
              <ul className="ml-4 list-disc">{(planView.plan.veriseti ?? []).map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>
              {(planView.plan.onkosullar ?? []).length > 0 && (<>
                <p className="mt-2 text-muted-foreground">Ön koşullar:</p>
                <ul className="ml-4 list-disc">{planView.plan.onkosullar.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul>
              </>)}
            </div>
          </div>
        </div>
      )}
      {!allRows.length ? (
        <p className="text-sm text-muted-foreground">Henüz analiz yok — &quot;User story analizi&quot; ile açıklama yeterliliği puanlanır ve teslim edilmiş dokümantasyon kontrol edilir.</p>
      ) : !rows.length ? (
        <p className="text-sm text-muted-foreground">
          Seçili durumda ({selectedStates.join(', ')}) story yok —{' '}
          <button type="button" className="text-primary underline" onClick={() => setSelectedStates([])}>filtreyi temizle</button>.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Story</th>
                <th className="px-3 py-2 text-left font-medium">Durum</th>
                <th className="px-3 py-2 text-left font-medium">Puan</th>
                <th className="px-3 py-2 text-left font-medium">Eksik</th>
                <th className="px-3 py-2 text-center font-medium">Doküman</th>
                <th className="px-3 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top hover:bg-muted/30">
                  <td className="max-w-[300px] px-3 py-2">
                    {adoOrg ? (
                      <a className="hover:underline" target="_blank" rel="noreferrer" href={`https://dev.azure.com/${adoOrg}/${encodeURIComponent(String(adoProject))}/_workitems/edit/${r.id}`}>
                        <span className="font-mono text-xs text-muted-foreground">#{r.id}</span> {r.title}
                      </a>
                    ) : (<span>#{r.id} {r.title}</span>)}
                    {r.assignee && <div className="text-xs text-muted-foreground">{r.assignee}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={/new|to do|proposed/i.test(String(r.state)) ? 'warning' : /active|doing|progress/i.test(String(r.state)) ? 'default' : /closed|done|removed/i.test(String(r.state)) ? 'neutral' : 'outline'}>
                      {r.state || '—'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                        <div className={`h-full ${r.score >= 70 ? 'bg-emerald-500' : r.score >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${r.score}%` }} />
                      </div>
                      <span className="font-mono text-xs">{r.score}</span>
                    </div>
                  </td>
                  <td className="max-w-[260px] px-3 py-2 text-xs text-muted-foreground">{r.eksik ?? '—'}</td>
                  <td className="px-3 py-2 text-center">{r.docDelivered ? <Badge variant="success">✓ {r.docSignal}</Badge> : <Badge variant="danger">yok</Badge>}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      {r.score < 50 && (
                        <Button size="sm" variant="ghost" title="AI ile açıklama + kabul kriteri taslağı" disabled={docBusy === String(r.id)} onClick={() => enrichStory(String(r.id))}>✍️</Button>
                      )}
                      <Button
                        size="sm"
                        disabled={docBusy === String(r.id) || docRunView?.run?.phase === 'running'}
                        onClick={() => makePlan(String(r.id), false, true)}
                      >
                        {docBusy === String(r.id) ? 'Hazırlanıyor…' : '📄 Doküman oluştur'}
                      </Button>
                      <Button size="sm" variant="outline" disabled={docBusy === String(r.id)} onClick={() => makePlan(String(r.id))}>
                        {docBusy === String(r.id) ? 'Hazırlanıyor…' : '📋 Plan hazırla'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ReadinessChecklist({ checks }: { checks: any[] }) {
  if (!checks.length) return null;
  return (
    <ul className="mb-4 grid gap-2 text-sm md:grid-cols-2">
      {checks.map((check: any) => (
        <li key={check.key} className="flex items-start gap-2 rounded-md border border-border/70 bg-background/45 p-2.5">
          <span aria-hidden>{check.ok ? '✅' : check.blocker ? '⛔' : '⚠️'}</span>
          <div className="min-w-0">
            <span>{check.message}</span>
            {check.fix && (
              <div className="mt-0.5 text-xs">
                → {check.fix.url?.startsWith('http')
                  ? <a className="text-primary underline" href={check.fix.url} target="_blank" rel="noreferrer">{check.fix.label}</a>
                  : check.fix.url?.startsWith('/')
                    ? <Link className="text-primary underline" href={check.fix.url}>{check.fix.label}</Link>
                    : check.fix.url?.startsWith('#')
                      ? <a className="text-primary underline" href={check.fix.url}>{check.fix.label}</a>
                      : <code>{check.fix.label}</code>}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

type LibraryDocument = {
  docId: string;
  title: string;
  wid?: string | number | null;
  surum?: string | null;
  screenshots?: number;
  has_diagram?: boolean;
  generatedAt?: string | null;
  htmlPath?: string;
  pdfPath?: string;
  content?: string;
  sections?: { key?: string; label?: string; title?: string }[];
};

const FALLBACK_DOC_SECTIONS = [
  { key: 'purpose', label: 'Amaç ve ön koşullar' },
  { key: 'concepts', label: 'Temel kavramlar' },
  { key: 'flow', label: 'Süreç akışı' },
  { key: 'situations', label: 'Durumlar ve terimler' },
];

function documentSectionOptions(doc: LibraryDocument) {
  const stored = Array.isArray(doc.sections)
    ? doc.sections
      .map((section) => ({ key: String(section?.key ?? ''), label: String(section?.label ?? section?.title ?? section?.key ?? '') }))
      .filter((section) => Boolean(section.key) && section.key !== 'cover')
    : [];
  return stored.length ? stored : FALLBACK_DOC_SECTIONS;
}

function DocumentLibrary({ projectId, revision, editDocumentId, onEditConsumed, onChanged }: {
  projectId: string;
  revision: number;
  editDocumentId: string | null;
  onEditConsumed: () => void;
  onChanged: () => void;
}) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ doc: LibraryDocument; content: string; loading: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sectionByDoc, setSectionByDoc] = useState<Record<string, string>>({});
  const [regenerating, setRegenerating] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const response: any = await api(`/projects/${projectId}/documents?kind=story_training_doc`);
      const rows = Array.isArray(response) ? response : response?.documents ?? [];
      setDocuments(rows);
      setError('');
    } catch (e: any) {
      setError(e.message || 'dokümanlar yüklenemedi');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadDocuments(); }, [loadDocuments, revision]);

  const openEditor = useCallback(async (doc: LibraryDocument) => {
    if (typeof doc.content === 'string') {
      setEditor({ doc, content: doc.content, loading: false });
      return;
    }
    setEditor({ doc, content: '', loading: true });
    try {
      // Older API responses did not expose content in the project library.
      // Use the existing tenant-scoped knowledge list only as a compatibility
      // bridge while upgraded deployments roll out.
      const response: any = await api(`/documents?projectId=${encodeURIComponent(projectId)}`);
      const rows = Array.isArray(response) ? response : response?.documents ?? [];
      const full = rows.find((row: any) => String(row.id ?? row.docId) === String(doc.docId));
      const content = full?.content ?? full?.metadata?.content;
      if (typeof content !== 'string') throw new Error('Düzenlenebilir doküman içeriği bulunamadı');
      setEditor({ doc: { ...doc, content }, content, loading: false });
    } catch (e: any) {
      setEditor(null);
      toast.error(e.message);
    }
  }, [projectId]);

  useEffect(() => {
    if (!editDocumentId) return;
    const doc = documents.find((item) => String(item.docId) === String(editDocumentId));
    if (!doc) return;
    void openEditor(doc);
    onEditConsumed();
  }, [documents, editDocumentId, onEditConsumed, openEditor]);

  async function saveDocument() {
    if (!editor || editor.loading) return;
    setSaving(true);
    try {
      const response: any = await api(`/projects/${projectId}/documents/${editor.doc.docId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: editor.content }),
      });
      if (!response?.ok) throw new Error(response?.detail ?? 'doküman kaydedilemedi');
      setDocuments((rows) => rows.map((row) => row.docId === editor.doc.docId ? { ...row, content: editor.content } : row));
      setEditor(null);
      toast.success('Doküman içeriği kaydedildi');
      onChanged();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  async function regenerateSection(doc: LibraryDocument) {
    const options = documentSectionOptions(doc);
    const sectionKey = sectionByDoc[doc.docId] ?? options[0]?.key;
    if (!doc.wid || !sectionKey) {
      toast.error('Bölüm veya story kimliği bulunamadı');
      return;
    }
    setRegenerating(doc.docId);
    try {
      const response: any = await api(`/projects/${projectId}/stories/${doc.wid}/doc/section`, {
        method: 'POST',
        body: JSON.stringify({ docId: doc.docId, sectionKey }),
      });
      if (!response?.ok) throw new Error(response?.detail ?? 'bölüm yeniden üretilemedi');
      if (editor?.doc.docId === doc.docId) setEditor(null);
      toast.success(`${options.find((option) => option.key === sectionKey)?.label ?? 'Bölüm'} yeniden üretildi`);
      onChanged();
    } catch (e: any) { toast.error(e.message); } finally { setRegenerating(null); }
  }

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <SectionTitle>Dokümanlar</SectionTitle>
          <p className="-mt-2 text-xs text-muted-foreground">Onaylı eğitim çıktıları, sürümleri ve yayın aksiyonları</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => { setLoading(true); void loadDocuments(); }} disabled={loading}>
          {loading ? 'Yükleniyor…' : 'Yenile'}
        </Button>
      </div>
      <div className="p-5">
        {loading ? (
          <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>
        ) : error ? (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : !documents.length ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">Henüz yayınlanmış doküman yok</p>
            <p className="mt-1 text-xs text-muted-foreground">Bir user story satırındaki “📄 Doküman oluştur” ile ilk çıktıyı başlatın.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((doc) => {
              const sectionOptions = documentSectionOptions(doc);
              const selectedSection = sectionByDoc[doc.docId] ?? sectionOptions[0]?.key ?? '';
              return (
                <li key={doc.docId} className="grid gap-3 py-4 first:pt-0 last:pb-0 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">{doc.title}</span>
                      {doc.wid != null && <Badge variant="outline">#{doc.wid}</Badge>}
                      <Badge variant="neutral">v{doc.surum || '1.0'}</Badge>
                      <Badge variant={(doc.screenshots ?? 0) > 0 ? 'success' : 'neutral'}>{doc.screenshots ?? 0} ekran</Badge>
                      {doc.has_diagram && <Badge variant="default">diyagram</Badge>}
                    </div>
                    {doc.generatedAt && (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">{new Date(doc.generatedAt).toLocaleString('tr-TR')}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {doc.htmlPath && (
                      <Button asChild size="sm" variant="outline">
                        <a href={apiStreamUrl(doc.htmlPath)} target="_blank" rel="noreferrer">HTML aç</a>
                      </Button>
                    )}
                    {doc.pdfPath && (
                      <Button asChild size="sm" variant="outline">
                        <a href={apiStreamUrl(doc.pdfPath)} target="_blank" rel="noreferrer" download>PDF indir</a>
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => void openEditor(doc)}>Düzenle</Button>
                    <Select
                      aria-label={`${doc.title} için yeniden üretilecek bölüm`}
                      className="h-8 max-w-[190px] text-xs"
                      value={selectedSection}
                      onChange={(event) => setSectionByDoc((state) => ({ ...state, [doc.docId]: event.target.value }))}
                    >
                      {sectionOptions.map((section) => <option key={section.key} value={section.key}>{section.label}</option>)}
                    </Select>
                    <Button size="sm" variant="ghost" disabled={regenerating === doc.docId} onClick={() => void regenerateSection(doc)}>
                      {regenerating === doc.docId ? 'Üretiliyor…' : '↻ yeniden üret'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Sheet open={Boolean(editor)} onOpenChange={(open) => { if (!open && !saving) setEditor(null); }}>
        {editor && (
          <SheetContent className="max-w-3xl" title={`${editor.doc.title} — Düzenle`}>
            <div className="flex h-full flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {editor.doc.wid != null && <Badge variant="outline">Story #{editor.doc.wid}</Badge>}
                <Badge variant="neutral">Markdown</Badge>
                <span>Kaydetme işlemi yalnız bu dokümanın içeriğini günceller.</span>
              </div>
              {editor.loading ? (
                <Skeleton className="min-h-[28rem] flex-1" />
              ) : (
                <Textarea
                  aria-label="Doküman Markdown içeriği"
                  className="min-h-[28rem] flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-ring"
                  value={editor.content}
                  onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                  spellCheck={false}
                />
              )}
              <div className="flex justify-end gap-2 border-t border-border pt-3">
                <Button variant="ghost" onClick={() => setEditor(null)} disabled={saving}>Vazgeç</Button>
                <Button onClick={saveDocument} disabled={saving || editor.loading}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</Button>
              </div>
            </div>
          </SheetContent>
        )}
      </Sheet>
    </Card>
  );
}

function RoleBrief({ projectId, brief, onGenerated }: { projectId: string; brief: any; onGenerated: () => void }) {
  const [busy, setBusy] = useState(false);
  async function generate() {
    setBusy(true);
    try {
      const r: any = await api(`/projects/${projectId}/brief`, { method: 'POST' });
      if (!r?.ok) throw new Error(r?.detail ?? 'brief üretilemedi');
      toast.success('Rol bazlı yapılacaklar güncellendi');
      onGenerated();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }
  return (
    <Card className="mt-6 p-5">
      <SectionTitle right={
        <div className="flex items-center gap-2">
          {brief?.generatedAt && <span className="text-xs text-muted-foreground">{new Date(brief.generatedAt).toLocaleString('tr-TR')}</span>}
          <Button size="sm" variant="outline" onClick={generate} disabled={busy}>{busy ? 'Hazırlanıyor…' : brief ? 'Yenile' : 'Oluştur'}</Button>
        </div>
      }>Rol Bazlı Yapılacaklar (PM · Lead Danışman · Developer)</SectionTitle>
      {!brief ? (
        <p className="text-sm text-muted-foreground">Henüz brif yok — &quot;Oluştur&quot; ile açık işlerden ve takipsiz konulardan rol bazlı aksiyon listesi üretilir (NIM).</p>
      ) : (
        <BriefMarkdown text={brief.content} />
      )}
    </Card>
  );
}

// Minimal markdown: ## headings → section titles, - / • / 1. lines → list items.
function BriefMarkdown({ text }: { text: string }) {
  const blocks = String(text).split(/\n(?=## )/);
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {blocks.map((b, i) => {
        const lines = b.trim().split('\n');
        const title = lines[0].replace(/^#+\s*/, '');
        const items = lines.slice(1).map((l) => l.replace(/^[-•*]\s*|^\d+\.\s*/, '').trim()).filter(Boolean);
        if (!items.length) return null;
        return (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-semibold">{title}</div>
            <ul className="space-y-1.5">
              {items.map((it, j) => (
                <li key={j} className="text-sm text-muted-foreground">
                  <span className="mr-1.5 text-primary">▸</span>
                  {it.replace(/\*\*/g, '')}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function BucketRow({ item }: { item: any }) {
  const due = item.due ? new Date(item.due) : null;
  const label =
    item.kind === 'ado' ? 'ADO' : item.kind === 'coverage' ? 'Coverage' : item.kind === 'task' ? 'Görev' : 'Aktivite';
  const inner = (
    <div className="flex items-center gap-3 py-2">
      <Badge variant={item.kind === 'coverage' ? 'warning' : 'outline'}>{label}</Badge>
      <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
      {item.extra?.assignee && <span className="hidden text-xs text-muted-foreground md:inline">{item.extra.assignee}</span>}
      {due && <span className="shrink-0 font-mono text-xs text-muted-foreground">{due.toLocaleDateString('tr-TR')}</span>}
    </div>
  );
  if (item.ref?.startsWith('http')) {
    return <li><a href={item.ref} target="_blank" rel="noreferrer" className="block hover:bg-muted/30">{inner}</a></li>;
  }
  if (item.ref) return <li><Link href={item.ref} className="block hover:bg-muted/30">{inner}</Link></li>;
  return <li>{inner}</li>;
}

function MappingsSheet({ p, onSaved }: { p: any; onSaved: () => void }) {
  const [devopsOrg, setDevopsOrg] = useState(p.devops_org ?? '');
  const [devopsProject, setDevopsProject] = useState(p.devops_project ?? '');
  const [teamId, setTeamId] = useState(p.teams_team_id ?? '');
  const [channels, setChannels] = useState(((p.teams_channel_ids as string[]) ?? []).join(', '));
  const [keywords, setKeywords] = useState(((p.mail_keywords as string[]) ?? []).join(', '));
  // WS6 tech stack: one repo per line "owner/name | bc-al|fno-xpp|web [| branch]",
  // one ISV per line "Ad | Publisher".
  const [purpose, setPurpose] = useState(p.purpose ?? '');
  const [repos, setRepos] = useState(((p.repos as any[]) ?? []).map((r: any) => [r.repo, r.kind, r.branch].filter(Boolean).join(' | ')).join('\n'));
  const [isvs, setIsvs] = useState(((p.isvs as any[]) ?? []).filter((i: any) => (i.source ?? 'manual') === 'manual').map((i: any) => [i.name, i.publisher].filter(Boolean).join(' | ')).join('\n'));
  const [teams, setTeams] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  const derivedIsvs = ((p.isvs as any[]) ?? []).filter((i: any) => (i.source ?? 'manual') !== 'manual');

  async function discover() {
    try {
      const r: any = await api(`/projects/${p.id}/discover-channels`);
      if (!r.connected) { toast.error('Graph bağlı değil'); return; }
      setTeams(r.teams ?? []);
    } catch (e: any) { toast.error(e.message); }
  }

  function parseRepos(): any[] {
    return repos.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
      const [repo, kind, branch] = l.split('|').map((s: string) => s.trim());
      return { repo, kind: ['bc-al', 'fno-xpp', 'web'].includes(kind) ? kind : 'bc-al', ...(branch ? { branch } : {}) };
    }).filter((r: any) => /^[\w.-]+\/[\w.-]+$/.test(r.repo));
  }

  async function save() {
    setSaving(true);
    try {
      const manualIsvs = isvs.split('\n').map((l: string) => l.trim()).filter(Boolean).map((l: string) => {
        const [name, publisher] = l.split('|').map((s: string) => s.trim());
        return { name, ...(publisher ? { publisher } : {}), source: 'manual' };
      });
      await api(`/projects/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          devops_org: devopsOrg || null,
          devops_project: devopsProject || null,
          purpose: purpose.trim() || null,
          teams_team_id: teamId || null,
          teams_channel_ids: channels.split(',').map((s: string) => s.trim()).filter(Boolean),
          mail_keywords: keywords.split(',').map((s: string) => s.trim()).filter(Boolean),
          repos: parseRepos(),
          isvs: [...manualIsvs, ...derivedIsvs],
        }),
      });
      toast.success('Eşlemeler kaydedildi');
      onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setSaving(false); }
  }

  // Save first (so the endpoint sees the current repo list), then profile.
  async function analyzeRepos() {
    setAnalyzing(true);
    try {
      await save();
      const r: any = await api(`/projects/${p.id}/analyze-repos`, { method: 'POST' });
      if (!r?.ok) throw new Error(r?.detail ?? 'analiz başarısız');
      const apps = (r.repos ?? []).reduce((n: number, x: any) => n + (x.apps?.length ?? 0), 0);
      toast.success(`Repo analizi tamam — ${r.repos?.length ?? 0} repo, ${apps} uygulama, ${r.isvs?.length ?? 0} ISV kaydı`);
      onSaved();
    } catch (e: any) { toast.error(e.message); } finally { setAnalyzing(false); }
  }

  return (
    <Sheet>
      <SheetTrigger asChild><Button variant="outline" size="sm"><Settings2 className="size-4" /> Eşlemeler</Button></SheetTrigger>
      <SheetContent title={`${p.name} — kanal eşlemeleri`}>
        <div className="space-y-4">
          <Field label="Projenin amacı (story geliştirmede kullanılır)">
            <textarea
              className="h-24 w-full rounded-md border border-border bg-background p-2 text-sm"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Örn: AGROZAN'ın NAV 2016'dan BC 24'e geçişi; hedef Ocak go-live, öncelik satın alma ve depo süreçleri, Continia ile e-fatura entegrasyonu."
            />
            <p className="mt-1 text-xs text-muted-foreground">Boş bırakılırsa AI story&apos;leri iş hedefini bilmeden geliştirir — çıktı genel kalır.</p>
          </Field>
          <Field label="ADO organizasyonu"><Input value={devopsOrg} onChange={(e) => setDevopsOrg(e.target.value)} placeholder="dynamicsops" /></Field>
          <Field label="ADO projesi"><Input value={devopsProject} onChange={(e) => setDevopsProject(e.target.value)} placeholder="Contoso-FO" /></Field>
          <Field label="Teams takım ID">
            <div className="flex gap-2">
              <Input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="takım guid" />
              <Button variant="outline" size="sm" onClick={discover}>Keşfet</Button>
            </div>
            {teams.length > 0 && (
              <select className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">— takım seç —</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
              </select>
            )}
          </Field>
          <Field label="Teams kanal ID'leri (virgülle)"><Input value={channels} onChange={(e) => setChannels(e.target.value)} /></Field>
          <Field label="E-posta anahtar kelimeleri (virgülle)"><Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="go-live, faz 2, warehouse" /></Field>
          <Field label="Repolar (satır başına: owner/name | bc-al · fno-xpp · web [| branch])">
            <textarea
              className="h-20 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
              value={repos}
              onChange={(e) => setRepos(e.target.value)}
              placeholder={'dynamicsops/DynOpsBC | bc-al\ndynamicsops/portal | web'}
            />
          </Field>
          <Field label="ISV çözümleri — manuel (satır başına: Ad | Publisher)">
            <textarea
              className="h-16 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
              value={isvs}
              onChange={(e) => setIsvs(e.target.value)}
              placeholder={'Continia Document Capture | Continia'}
            />
            {derivedIsvs.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">+ {derivedIsvs.length} otomatik keşfedilen ISV (repo/ortam) — analizle güncellenir, silinmez.</p>
            )}
          </Field>
          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || analyzing}>{saving ? 'Kaydediliyor…' : 'Kaydet'}</Button>
            <Button variant="outline" onClick={analyzeRepos} disabled={saving || analyzing}>{analyzing ? 'Analiz ediliyor…' : '🔎 Repoları analiz et'}</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
