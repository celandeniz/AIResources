'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../../../lib/api';
import { toast } from '../../../../components/ui/toaster';
import { PageHeader } from '../../../../components/domain';
import { Card } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Code2, ArrowLeft, ExternalLink } from 'lucide-react';

interface CodeTaskResult {
  ok: boolean;
  mock?: boolean;
  summary?: string;
  diff?: string;
  shareUrl?: string;
  detail?: string;
}
interface CodeTaskDetail {
  id: string;
  title: string;
  repo?: string;
  instruction: string;
  model?: string;
  agent?: string;
  status: string;
  result?: CodeTaskResult;
  share_url?: string;
  created_at: string;
}

const STATUS_VARIANT: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'warning',
  approved: 'warning',
  running: 'warning',
  done: 'success',
  failed: 'danger',
};

export default function CodeTaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<CodeTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api(`/code-tasks/${id}`)
      .then((d: CodeTaskDetail) => {
        setTask(d);
        setLoading(false);
      })
      .catch((e: any) => {
        toast.error(e.message ?? 'Görev yüklenemedi');
        setLoading(false);
      });
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Görev yükleniyor…
      </div>
    );
  }

  if (!task) {
    return (
      <div className="py-20 text-center">
        <p className="text-sm text-muted-foreground">Görev bulunamadı.</p>
        <Button className="mt-4" onClick={() => router.push('/code-tasks')} variant="outline">
          <ArrowLeft className="size-4" /> Geri
        </Button>
      </div>
    );
  }

  const result = task.result;
  const shareUrl = task.share_url ?? result?.shareUrl;

  return (
    <div>
      <PageHeader
        title={task.title}
        subtitle={task.repo ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[task.status] ?? 'neutral'} className="capitalize">{task.status}</Badge>
            <Badge variant="neutral"><Code2 className="size-3" />Code Task</Badge>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap gap-3">
        <Button onClick={() => router.push('/code-tasks')} variant="outline" size="sm">
          <ArrowLeft className="size-4" /> Görevler
        </Button>
      </div>

      {/* Meta */}
      <Card className="mb-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Model</div>
            <div className="mt-0.5 text-sm">{task.model ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Agent</div>
            <div className="mt-0.5 text-sm">{task.agent ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs font-medium text-muted-foreground">Repo</div>
            <div className="mt-0.5 text-sm">{task.repo ?? '—'}</div>
          </div>
        </div>

        <div className="mt-5">
          <div className="text-xs font-medium text-muted-foreground">Görev Tanımı</div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{task.instruction}</p>
        </div>
      </Card>

      {/* Result */}
      {result ? (
        <Card className="p-6">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Sonuç</h3>
            {result.mock && <Badge variant="neutral">MOCK</Badge>}
          </div>

          {result.detail && !result.ok && (
            <p className="mb-3 text-sm text-danger">{result.detail}</p>
          )}

          {result.summary && (
            <p className="whitespace-pre-wrap text-sm text-foreground">{result.summary}</p>
          )}

          {result.diff && (
            <pre className="mt-4 max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/30 p-4 text-xs leading-relaxed">
              {result.diff}
            </pre>
          )}

          {shareUrl && (
            <div className="mt-4">
              <a
                href={shareUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <ExternalLink className="size-4" /> OpenCode oturumunu aç
              </a>
            </div>
          )}
        </Card>
      ) : (
        <Card className="px-5 py-12 text-center text-sm text-muted-foreground">
          Bu görev henüz çalıştırılmadı. Onaylandıktan sonra sonuç burada görünecek.
        </Card>
      )}
    </div>
  );
}
