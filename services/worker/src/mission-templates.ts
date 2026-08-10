// Typed Mission Pod templates — deterministic stage graphs for autonomous
// BC / F&SCM dev work, selected from the ADO work item's type/tags/area path.
// `agent` stages run through the normal activity pipeline; `code`/`ci`/`pr`
// stages are SYSTEM stages executed deterministically by mission-stages.ts
// (they never depend on an LLM proposing the right tool). No template match →
// the generic scoring planner keeps handling the mission (consulting flow).

export interface AdoMeta {
  id?: string;
  org?: string | null;
  project?: string | null;
  type?: string | null;
  tags?: string[];
  iterationPath?: string | null;
  areaPath?: string | null;
}

export type StageKind = 'agent' | 'code' | 'ci' | 'pr';

export interface StageDef {
  key: string;
  title: string;
  kind: StageKind;
  requiredRole?: string; // ai_resources.key — explicit, replaces substring scoring
  dependsOn: string[]; // stage keys
  reportProgress?: boolean; // emits a progressive ADO comment on completion
  description?: string;
  config?: Record<string, unknown>;
}

export interface MissionTemplate {
  key: string;
  match: (ado: AdoMeta) => boolean;
  stages: StageDef[];
}

const DEV_REPO = process.env.DEV_POD_REPO ?? 'dynamicsops/DynOpsBC'; // owner/repo on GitHub
const DEV_REPO_KEY = process.env.DEV_POD_REPO_KEY ?? 'dynopsbc'; // OPENCODE_SERVERS key
const DEV_CI_WORKFLOW = process.env.DEV_POD_CI_WORKFLOW ?? 'CICD.yaml';
const DEV_BASE_BRANCH = process.env.DEV_POD_BASE_BRANCH ?? 'main';

export const TEMPLATES: MissionTemplate[] = [
  {
    key: 'bc_dev',
    // BC AL development: work item typed as dev work AND scoped to the BC apps
    // (area path / tags / project naming: Warehouse, Production, OSDPRD, OSDWHS).
    match: (a) =>
      /bug|task|user story|product backlog item|feature/i.test(a.type ?? '') &&
      /(warehouse|production|\bbc\b|osdprd|osdwhs|dynopsbc|business central)/i.test(
        `${a.areaPath ?? ''} ${a.project ?? ''} ${(a.tags ?? []).join(' ')}`,
      ),
    stages: [
      {
        key: 'analyze', title: 'Fonksiyonel analiz & kabul kriterleri', kind: 'agent',
        requiredRole: 'ai_bc_functional', dependsOn: [], reportProgress: true,
        description: 'Analyse the work item functionally: requirement summary, standard-first fit/gap, acceptance criteria, affected BC objects. Base your analysis strictly on the ticket + comments.',
      },
      {
        key: 'design', title: 'Teknik tasarım (AL)', kind: 'agent',
        requiredRole: 'ai_al_developer', dependsOn: ['analyze'],
        description: 'Produce the AL technical design: objects to create/change (naming per OSDPRD/OSDWHS conventions, id ranges from app.json), events/subscribers, upgrade considerations, and a concrete implementation checklist.',
      },
      {
        key: 'implement', title: 'Implementasyon (OpenCode)', kind: 'code',
        dependsOn: ['design'], reportProgress: true,
        config: { repo: DEV_REPO, repoKey: DEV_REPO_KEY },
      },
      {
        key: 'tests', title: 'AL test codeunits', kind: 'code',
        dependsOn: ['implement'],
        config: { repo: DEV_REPO, repoKey: DEV_REPO_KEY, testStage: true },
      },
      {
        key: 'ci', title: 'AL-Go build & test (CI)', kind: 'ci',
        dependsOn: ['tests'],
        config: { repo: DEV_REPO, workflow: DEV_CI_WORKFLOW, maxRepairAttempts: 2 },
      },
      {
        key: 'document', title: 'Dokümantasyon', kind: 'agent',
        requiredRole: 'ai_technical_writer', dependsOn: ['ci'],
        description: 'Write the change documentation: Change Summary, Functional Impact, Setup & Permissions, Test Evidence, Release Note. Use the design + implementation outputs above.',
      },
      {
        key: 'docs_commit', title: 'Dokümanları branch\'e ekle', kind: 'code',
        dependsOn: ['document'],
        config: { repo: DEV_REPO, repoKey: DEV_REPO_KEY, docsStage: true },
      },
      {
        key: 'open_pr', title: 'Pull request aç', kind: 'pr',
        dependsOn: ['docs_commit'], reportProgress: true,
        config: { repo: DEV_REPO, base: DEV_BASE_BRANCH },
      },
      {
        key: 'synthesis', title: 'QA özeti & teslim', kind: 'agent',
        requiredRole: 'ai_qa_lead', dependsOn: ['open_pr'],
        description: 'Synthesize the delivery: what changed, test coverage, CI result, PR link, remaining risks, and the recommendation for the human merge decision.',
      },
    ],
  },
  {
    key: 'fscm_dev',
    // F&SCM / X++ work: agent-only stages until an X++ toolchain exists —
    // analysis, design, implementation SPEC, test plan, docs, synthesis.
    match: (a) =>
      /x\+\+|xpp|f&scm|fno|d365fo|finance|scm|aga/i.test(
        `${a.areaPath ?? ''} ${a.project ?? ''} ${(a.tags ?? []).join(' ')}`,
      ),
    stages: [
      {
        key: 'analyze', title: 'Fonksiyonel analiz (F&SCM)', kind: 'agent',
        requiredRole: 'ai_d365fo_functional', dependsOn: [], reportProgress: true,
        description: 'Analyse the work item: process context, fit-gap vs standard F&SCM, acceptance criteria.',
      },
      {
        key: 'design', title: 'X++ teknik tasarım', kind: 'agent',
        requiredRole: 'ai_xpp_architect', dependsOn: ['analyze'],
        description: 'Produce the X++ technical design: extension points, CoC methods, data entities, security artifacts, and a step-by-step implementation spec a developer can execute.',
      },
      {
        key: 'test_plan', title: 'Test planı', kind: 'agent',
        requiredRole: 'ai_qa_lead', dependsOn: ['design'],
        description: 'Write the test plan: SysTest scenarios, functional UAT script, regression scope.',
      },
      {
        key: 'document', title: 'Dokümantasyon', kind: 'agent',
        requiredRole: 'ai_technical_writer', dependsOn: ['design'],
        description: 'Write the change documentation and release note for this F&SCM customization.',
      },
      {
        key: 'synthesis', title: 'Teslim özeti', kind: 'agent',
        requiredRole: 'ai_delivery_pm', dependsOn: ['test_plan', 'document'], reportProgress: true,
        description: 'Synthesize the full delivery package (analysis, design, test plan, docs) into the ticket resolution.',
      },
    ],
  },
];

export function selectTemplate(ado?: AdoMeta | null): MissionTemplate | null {
  if (!ado) return null;
  const enabled = (process.env.DEV_POD_TEMPLATES ?? 'bc_dev,fscm_dev')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of TEMPLATES) {
    if (!enabled.includes(t.key)) continue;
    try {
      if (t.match(ado)) return t;
    } catch { /* defensive */ }
  }
  return null;
}
