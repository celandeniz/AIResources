// Due-date bucketing for project dashboards: overdue / this week / next week /
// this month / later. ISO weeks, Monday start (Turkish locale convention).

export type DueBucket = 'overdue' | 'this_week' | 'next_week' | 'this_month' | 'later' | 'undated';

export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // Monday start
  out.setDate(out.getDate() - diff);
  return out;
}

export function bucketFor(due: Date | string | null | undefined, now: Date = new Date()): DueBucket {
  if (!due) return 'undated';
  const d = typeof due === 'string' ? new Date(due) : due;
  if (Number.isNaN(d.getTime())) return 'undated';
  if (d.getTime() < now.getTime()) return 'overdue';
  const weekStart = startOfWeek(now);
  const nextWeekStart = new Date(weekStart);
  nextWeekStart.setDate(weekStart.getDate() + 7);
  const weekAfterNextStart = new Date(weekStart);
  weekAfterNextStart.setDate(weekStart.getDate() + 14);
  if (d < nextWeekStart) return 'this_week';
  if (d < weekAfterNextStart) return 'next_week';
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  if (d < monthEnd) return 'this_month';
  return 'later';
}

export function bucketByDue<T>(
  items: T[],
  getDue: (item: T) => Date | string | null | undefined,
  now: Date = new Date(),
): Record<DueBucket, T[]> {
  const out: Record<DueBucket, T[]> = { overdue: [], this_week: [], next_week: [], this_month: [], later: [], undated: [] };
  for (const item of items) out[bucketFor(getDue(item), now)].push(item);
  return out;
}
