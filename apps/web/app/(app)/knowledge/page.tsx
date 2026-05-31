'use client';
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { toast } from '../../../components/ui/toaster';
import { PageHeader, SectionTitle, EmptyState } from '../../../components/domain';
import { Card } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Input, Textarea } from '../../../components/ui/input';
import { Link2, Search, Upload, FileText, BookOpen, FolderSync } from 'lucide-react';

export default function KnowledgePage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [urlTitle, setUrlTitle] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [urlBusy, setUrlBusy] = useState(false);
  const [obsidian, setObsidian] = useState<any>(null);

  async function load() { setDocs(await api('/documents')); }
  async function loadObsidian() { try { setObsidian(await api('/knowledge/obsidian/status')); } catch {} }
  useEffect(() => { load().catch(() => {}); loadObsidian(); }, []);
  // While a sweep runs, poll status so the indexed count climbs live.
  useEffect(() => {
    if (!obsidian?.running) return;
    const t = setInterval(loadObsidian, 4000);
    return () => clearInterval(t);
  }, [obsidian?.running]);

  async function syncObsidian() {
    try {
      const r = await api('/knowledge/obsidian/sync', { method: 'POST', body: JSON.stringify({}) });
      toast.success(r.started ? 'Obsidian sync started — indexing in the background…' : 'Sync already running');
      setTimeout(loadObsidian, 1500);
    } catch (e: any) { toast.error(e.message); }
  }

  async function upload() {
    setBusy(true);
    try { await api('/documents', { method: 'POST', body: JSON.stringify({ title, text }) }); setTitle(''); setText(''); toast.success('Uploaded & indexed'); await load(); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }
  async function search() {
    try { const r = await api('/knowledge/search', { method: 'POST', body: JSON.stringify({ query, topK: 5 }) }); setResults(r.results ?? []); }
    catch (e: any) { toast.error(e.message); }
  }
  async function ingestUrl() {
    setUrlBusy(true);
    try {
      const r = await api('/knowledge/ingest-url', { method: 'POST', body: JSON.stringify({ url, title: urlTitle || undefined }) });
      setUrl('');
      setUrlTitle('');
      toast.success(`Indexed ${r.chunks ?? 0} chunks`);
      await load();
    } catch (e: any) { toast.error(e.message); } finally { setUrlBusy(false); }
  }

  return (
    <div>
      <PageHeader title="Knowledge Base" subtitle="Upload documents → chunked & embedded into the vector store · semantic search with citations." />
      {obsidian?.configured && (
        <Card className="mb-5 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-primary/10 p-2 text-primary"><FolderSync className="size-5" /></div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium">Obsidian Vault</span>
                <Badge variant="success">local</Badge>
                {obsidian.running && <Badge variant="warning">syncing…</Badge>}
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {obsidian.indexed} notes indexed · read-only mount · daily auto-sync · nothing leaves this machine.
                {obsidian.lastResult && ` Last: +${obsidian.lastResult.ingested} new, ${obsidian.lastResult.skipped} unchanged.`}
              </p>
            </div>
          </div>
          <Button onClick={syncObsidian} disabled={obsidian.running}><FolderSync className="size-4" />{obsidian.running ? 'Syncing…' : 'Sync now'}</Button>
        </Card>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle>Upload</SectionTitle>
          <div className="space-y-3">
            <Input placeholder="Document title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="Paste document text…" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <Button onClick={upload} disabled={!title || !text || busy}><Upload className="size-4" />{busy ? 'Indexing…' : 'Upload & index'}</Button>
          </div>
          <SectionTitle>Add from URL</SectionTitle>
          <div className="space-y-3">
            <Input placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} />
            <Input placeholder="Optional title" value={urlTitle} onChange={(e) => setUrlTitle(e.target.value)} />
            <Button onClick={ingestUrl} disabled={!url || urlBusy}><Link2 className="size-4" />{urlBusy ? 'Indexing…' : 'Fetch & index'}</Button>
          </div>
          <SectionTitle right={<span className="text-xs text-muted-foreground">{docs.length}</span>}>Documents</SectionTitle>
          <div className="space-y-1.5">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2">
                <FileText className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate text-sm">{d.title}</span>
                <Badge variant={d.status === 'indexed' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>{d.status}</Badge>
                <span className="font-mono text-xs text-muted-foreground tnum">{d.chunk_count} chunks</span>
              </div>
            ))}
            {!docs.length && <p className="text-sm text-muted-foreground">No documents yet.</p>}
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle>Semantic search</SectionTitle>
          <div className="flex gap-2">
            <Input placeholder="Search the knowledge base…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
            <Button onClick={search} disabled={!query}><Search className="size-4" /></Button>
          </div>
          <div className="mt-4 space-y-2">
            {results.map((r, i) => (
              <div key={i} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{r.title ?? 'result'}</span>
                  <Badge variant="neutral">score {typeof r.score === 'number' ? r.score.toFixed(3) : r.score}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{r.snippet}</p>
              </div>
            ))}
            {!results.length && <EmptyState icon={BookOpen} title="Search your knowledge" hint="Results appear here with similarity scores." />}
          </div>
        </Card>
      </div>
    </div>
  );
}
