import type { CosmosTimelog, CosmosTask } from '../../integrations/cosmos/timelog.service';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export interface ProjectTotal {
  project: string;
  hours: number;
  recordCount: number;
  sharePct: number;
}

export interface UserByProjectMatrix {
  users: string[];
  projects: string[];
  matrix: Record<string, Record<string, number>>;
  userTotals: Record<string, number>;
  projectTotals: Record<string, number>;
}

export interface TaskTotal {
  workItemId: string;
  title: string;
  project: string;
  originalEstimate: number;
  approvedEffort: number;   // timer-based: Σ core_time_logs.duration in the period
  workItemEffort: number;   // ADO effort: core_devops_tasks.completed_work (cumulative, full)
  recordCount: number;
  variance: number; // workItemEffort - originalEstimate
}

export interface ResourceTotal {
  user: string;
  hours: number;
  recordCount: number;
  sharePct: number;
}

export interface DetailRecord {
  hours: number;
  user: string;
  workItemId: string;
  date: string;      // ISO date
  week: string;      // ISO week: yyyy-Www
  type?: string;
  description?: string;
  title?: string;
}

export interface ProjectDetail {
  project: string;
  records: DetailRecord[];
}

export interface ReportData {
  orgLabel: string;
  projectLabel?: string;
  periodLabel: string;
  projectTotals: ProjectTotal[];
  userByProject: UserByProjectMatrix;
  taskTotals: TaskTotal[];
  resourceTotals: ResourceTotal[];
  detailsByProject: ProjectDetail[];
  grand: { hours: number; recordCount: number; workItemEffort: number; originalEstimate: number };
  grouping: { byTask: boolean; byResource: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function toIsoDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function toIsoWeek(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  // ISO week: get the thursday of the week
  const thursday = new Date(d);
  thursday.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 3);
  const yearStart = new Date(thursday.getFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildReport — pure function, no side effects
// ─────────────────────────────────────────────────────────────────────────────
export function buildReport(opts: {
  orgLabel: string;
  projectLabel?: string;
  periodLabel: string;
  timelogs: CosmosTimelog[];
  tasks: CosmosTask[];
  userNames: Record<string, string>;
  grouping: { byTask?: boolean; byResource?: boolean };
}): ReportData {
  const { orgLabel, projectLabel, periodLabel, timelogs, tasks, userNames, grouping } = opts;
  const byTask = grouping.byTask !== false;
  const byResource = grouping.byResource !== false;

  // ── Project totals ───────────────────────────────────────────────────────
  const projectHours: Record<string, number> = {};
  const projectCount: Record<string, number> = {};
  for (const t of timelogs) {
    const p = t.project || 'Unknown';
    projectHours[p] = (projectHours[p] ?? 0) + t.hours;
    projectCount[p] = (projectCount[p] ?? 0) + 1;
  }
  const totalHours = Object.values(projectHours).reduce((s, v) => s + v, 0);
  const projectTotals: ProjectTotal[] = Object.entries(projectHours)
    .sort(([, a], [, b]) => b - a)
    .map(([project, hours]) => ({
      project,
      hours: Math.round(hours * 100) / 100,
      recordCount: projectCount[project] ?? 0,
      sharePct: totalHours > 0 ? Math.round((hours / totalHours) * 1000) / 10 : 0,
    }));

  // ── User×Project matrix ──────────────────────────────────────────────────
  const matrixRaw: Record<string, Record<string, number>> = {};
  const userTotals: Record<string, number> = {};
  for (const t of timelogs) {
    const userName = userNames[t.userId] ?? t.userId ?? 'Unknown';
    const proj = t.project || 'Unknown';
    if (!matrixRaw[userName]) matrixRaw[userName] = {};
    matrixRaw[userName][proj] = (matrixRaw[userName][proj] ?? 0) + t.hours;
    userTotals[userName] = (userTotals[userName] ?? 0) + t.hours;
  }
  const allUsers = Object.keys(matrixRaw).sort();
  const allProjects = Object.keys(projectHours).sort();
  const userByProject: UserByProjectMatrix = {
    users: allUsers,
    projects: allProjects,
    matrix: matrixRaw,
    userTotals,
    projectTotals: projectHours,
  };

  // ── Task totals (join logs ↔ tasks by workItemId) ─────────────────────────
  const taskLogHours: Record<string, number> = {};
  const taskLogCount: Record<string, number> = {};
  const taskLogProject: Record<string, string> = {};
  for (const t of timelogs) {
    const id = t.workItemId || '';
    if (!id) continue;
    taskLogHours[id] = (taskLogHours[id] ?? 0) + t.hours;
    taskLogCount[id] = (taskLogCount[id] ?? 0) + 1;
    if (!taskLogProject[id]) taskLogProject[id] = t.project || 'Unknown';
  }
  const taskMap: Record<string, CosmosTask> = {};
  for (const t of tasks) taskMap[t.workItemId] = t;

  // Scope = work items that have a timer entry in the period (Σduration > 0).
  // For each, show BOTH the timer total (period-accurate) and the full ADO
  // work-item effort (completed_work — matches the customer's source numbers).
  const allWorkItemIds = new Set([...Object.keys(taskLogHours)]);
  const taskTotals: TaskTotal[] = [...allWorkItemIds]
    .map((id) => {
      const task = taskMap[id];
      const approvedEffort = Math.round((taskLogHours[id] ?? 0) * 100) / 100;
      // ADO effort: prefer completed_work, fall back to logged, then to the timer total.
      const workItemEffortRaw = task
        ? (task.completedWork || task.logged || 0)
        : 0;
      const workItemEffort = Math.round((workItemEffortRaw || approvedEffort) * 100) / 100;
      const originalEstimate = task?.originalEstimate ?? 0;
      return {
        workItemId: id,
        title: task?.title ?? id,
        project: task?.project ?? taskLogProject[id] ?? 'Unknown',
        originalEstimate,
        approvedEffort,
        workItemEffort,
        recordCount: taskLogCount[id] ?? 0,
        variance: Math.round((workItemEffort - originalEstimate) * 100) / 100,
      } as TaskTotal;
    })
    .sort((a, b) => b.workItemEffort - a.workItemEffort);

  const taskWorkItemEffort = Math.round(taskTotals.reduce((s, t) => s + t.workItemEffort, 0) * 100) / 100;
  const taskOriginalEstimate = Math.round(taskTotals.reduce((s, t) => s + t.originalEstimate, 0) * 100) / 100;

  // ── Resource totals ──────────────────────────────────────────────────────
  const resourceTotals: ResourceTotal[] = Object.entries(userTotals)
    .sort(([, a], [, b]) => b - a)
    .map(([user, hours]) => ({
      user,
      hours: Math.round(hours * 100) / 100,
      recordCount: timelogs.filter((t) => (userNames[t.userId] ?? t.userId) === user).length,
      sharePct: totalHours > 0 ? Math.round((hours / totalHours) * 1000) / 10 : 0,
    }));

  // ── Detail records by project ─────────────────────────────────────────────
  const detailsByProject: ProjectDetail[] = [];
  for (const { project } of projectTotals) {
    const records = timelogs
      .filter((t) => (t.project || 'Unknown') === project)
      .sort((a, b) => a.dateMs - b.dateMs)
      .map((t) => ({
        hours: t.hours,
        user: userNames[t.userId] ?? t.userId ?? 'Unknown',
        workItemId: t.workItemId || '',
        date: t.dateStr ?? toIsoDate(t.dateMs),
        week: toIsoWeek(t.dateMs),
        type: t.workType,
        description: t.comment,
        title: t.title,
      } as DetailRecord));
    detailsByProject.push({ project, records });
  }

  return {
    orgLabel,
    projectLabel,
    periodLabel,
    projectTotals,
    userByProject,
    taskTotals,
    resourceTotals,
    detailsByProject,
    grand: {
      hours: Math.round(totalHours * 100) / 100,
      recordCount: timelogs.length,
      workItemEffort: taskWorkItemEffort,
      originalEstimate: taskOriginalEstimate,
    },
    grouping: { byTask, byResource },
  };
}
