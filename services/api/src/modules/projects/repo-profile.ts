// Repo profiling for tech-stack-aware documentation (WS6).
// A profile is a compact, cacheable summary of what a project repo CONTAINS:
//  - bc-al  → AL apps from app.json (name/publisher/version/idRanges) with
//             their dependencies (= installed ISV signal)
//  - fno-xpp→ X++ model names from Descriptor XMLs (best-effort)
//  - web    → framework detection from package.json + scripts
// plus the README head and a capped file-path list used later for
// story-keyword → code-excerpt matching. Everything is best-effort: a repo we
// cannot read yields an empty profile, never an error.

import { getFileContent, getLanguages, getReadme, getRepoTree } from '../../integrations/github/github.adapter';

export interface RepoRef { repo: string; kind: 'bc-al' | 'fno-xpp' | 'web'; branch?: string }

export interface RepoAppInfo {
  name: string;
  publisher?: string;
  version?: string;
  idRanges?: { from: number; to: number }[];
  dependencies: { name: string; publisher?: string; version?: string }[];
}

export interface RepoProfile {
  repo: string;
  kind: RepoRef['kind'];
  branch?: string;
  fileCount: number;
  apps: RepoAppInfo[];        // bc-al
  models: string[];           // fno-xpp
  framework: string | null;   // web
  scripts: Record<string, string>;
  languages: string[];
  readme: string | null;
  // Capped path list for keyword matching (code + docs only).
  tree: string[];
  analyzedAt: string;
  error?: string;
}

const CODE_EXT_RE = /\.(al|xpp|xml|ts|tsx|js|jsx|vue|cs|py|md|json)$/i;
const TREE_CAP = 1500;

const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@angular/core', 'Angular'], ['vue', 'Vue'],
  ['react', 'React'], ['svelte', 'Svelte'], ['express', 'Express'], ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
];

export async function analyzeRepo(ref: RepoRef): Promise<RepoProfile> {
  const profile: RepoProfile = {
    repo: ref.repo, kind: ref.kind, branch: ref.branch,
    fileCount: 0, apps: [], models: [], framework: null, scripts: {},
    languages: [], readme: null, tree: [], analyzedAt: new Date().toISOString(),
  };
  const tree = await getRepoTree(ref.repo, ref.branch);
  if (!tree.length) {
    profile.error = 'repo ağacı okunamadı (token/erişim/isim kontrol edin)';
    return profile;
  }
  profile.fileCount = tree.length;
  profile.tree = tree.map((t) => t.path).filter((p) => CODE_EXT_RE.test(p)).slice(0, TREE_CAP);
  profile.readme = await getReadme(ref.repo, 800);
  profile.languages = Object.keys(await getLanguages(ref.repo)).slice(0, 6);

  if (ref.kind === 'bc-al') {
    // Every app.json in the tree is one AL app; its dependencies list the ISVs
    // (and Microsoft base apps) the extension is built on.
    const appJsons = tree.filter((t) => /(^|\/)app\.json$/i.test(t.path)).slice(0, 8);
    for (const f of appJsons) {
      const raw = await getFileContent(ref.repo, f.path, 30_000);
      if (!raw) continue;
      try {
        const j = JSON.parse(raw);
        profile.apps.push({
          name: String(j.name ?? f.path),
          publisher: j.publisher ? String(j.publisher) : undefined,
          version: j.version ? String(j.version) : undefined,
          idRanges: Array.isArray(j.idRanges) ? j.idRanges.slice(0, 4) : undefined,
          dependencies: (Array.isArray(j.dependencies) ? j.dependencies : [])
            .map((d: any) => ({ name: String(d.name ?? d.appId ?? '?'), publisher: d.publisher ? String(d.publisher) : undefined, version: d.version ? String(d.version) : undefined }))
            .slice(0, 20),
        });
      } catch { /* malformed app.json — skip */ }
    }
  } else if (ref.kind === 'fno-xpp') {
    // Model names from Descriptor XMLs (AOT layout: <Model>/Descriptor/<Model>.xml).
    const descriptors = tree.filter((t) => /\/Descriptor\/[^/]+\.xml$/i.test(t.path)).slice(0, 12);
    profile.models = [...new Set(descriptors.map((d) => d.path.split('/Descriptor/')[0].split('/').pop() ?? ''))].filter(Boolean);
  } else {
    // web: root package.json → framework + scripts.
    const pkgPath = tree.find((t) => t.path === 'package.json')?.path ?? tree.find((t) => /(^|\/)package\.json$/.test(t.path))?.path;
    if (pkgPath) {
      const raw = await getFileContent(ref.repo, pkgPath, 30_000);
      try {
        const j = raw ? JSON.parse(raw) : null;
        const deps = { ...(j?.dependencies ?? {}), ...(j?.devDependencies ?? {}) };
        profile.framework = FRAMEWORKS.find(([k]) => deps[k])?.[1] ?? null;
        profile.scripts = Object.fromEntries(Object.entries(j?.scripts ?? {}).slice(0, 8)) as Record<string, string>;
      } catch { /* malformed package.json */ }
    }
  }
  return profile;
}

// ISV entries derived from a profile (source:'repo'): the app.json dependency
// list minus Microsoft base/system apps (those are platform, not ISV).
export function isvsFromProfile(profile: RepoProfile): { name: string; publisher?: string; source: 'repo' }[] {
  const out: { name: string; publisher?: string; source: 'repo' }[] = [];
  for (const app of profile.apps) {
    for (const d of app.dependencies) {
      if (/^microsoft$/i.test(d.publisher ?? '')) continue;
      out.push({ name: d.name, publisher: d.publisher, source: 'repo' });
    }
  }
  return out;
}

// Story-keyword → file matching for code excerpts (≤3 files). Keywords are
// title/description words ≥4 chars; a path matches when it contains any
// keyword (case/dıacritic-insensitive, tr→ascii folded).
const fold = (s: string) => s.toLowerCase()
  .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');

export function extractKeywords(text: string, max = 12): string[] {
  const STOP = new Set(['için', 'olarak', 'olan', 'this', 'that', 'with', 'from', 'user', 'story', 'task', 'yeni', 'daha', 'sonra', 'önce', 'gibi', 'veya']);
  return [...new Set(
    fold(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)),
  )].slice(0, max);
}

export function findRelevantFiles(profiles: RepoProfile[], keywords: string[], cap = 3): { repo: string; path: string }[] {
  if (!keywords.length) return [];
  const scored: { repo: string; path: string; score: number }[] = [];
  for (const p of profiles) {
    for (const path of p.tree) {
      if (!/\.(al|xpp|ts|tsx|md)$/i.test(path)) continue;
      const fp = fold(path);
      const score = keywords.reduce((n, k) => n + (fp.includes(k) ? 1 : 0), 0);
      if (score > 0) scored.push({ repo: p.repo, path, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, cap).map(({ repo, path }) => ({ repo, path }));
}
