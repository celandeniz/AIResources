import { BadRequestException } from '@nestjs/common';

export interface ReportRow {
  label: string;
  value: number;
}

export interface ReportResult {
  report: string;
  columns: ['label', 'value'];
  rows: ReportRow[];
  suggestedChart: { type: 'bar' | 'donut'; title: string };
}

// Safe report catalog — all aggregations via Prisma (no raw SQL).
// The prisma argument is the tenant-guarded PrismaService so results are
// workspace-scoped automatically.
export async function runReport(
  prisma: any,
  reportKey: string,
  // params currently reserved for future date-range filtering
  _params?: Record<string, unknown>,
): Promise<ReportResult> {
  switch (reportKey) {
    case 'activities_by_status': {
      const groups = await prisma.activities.groupBy({ by: ['status'], _count: { id: true } });
      const rows: ReportRow[] = groups.map((g: any) => ({ label: g.status, value: g._count.id }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'bar', title: 'Activities by Status' },
      };
    }

    case 'activities_by_resource': {
      const groups = await prisma.activities.groupBy({
        by: ['assigned_resource_id'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      });
      const ids = groups.map((g: any) => g.assigned_resource_id).filter(Boolean);
      const resources: any[] = ids.length
        ? await prisma.ai_resources.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
      const nameMap = Object.fromEntries(resources.map((r: any) => [r.id, r.name]));
      const rows: ReportRow[] = groups.map((g: any) => ({
        label: g.assigned_resource_id ? (nameMap[g.assigned_resource_id] ?? g.assigned_resource_id) : '(unassigned)',
        value: g._count.id,
      }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'bar', title: 'Activities by Resource (Top 10)' },
      };
    }

    case 'approvals_by_status': {
      const groups = await prisma.approvals.groupBy({ by: ['status'], _count: { id: true } });
      const rows: ReportRow[] = groups.map((g: any) => ({ label: g.status, value: g._count.id }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'donut', title: 'Approvals by Status' },
      };
    }

    case 'tasks_by_status': {
      const groups = await prisma.tasks.groupBy({ by: ['status'], _count: { id: true } });
      const rows: ReportRow[] = groups.map((g: any) => ({ label: g.status, value: g._count.id }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'donut', title: 'Tasks by Status' },
      };
    }

    case 'missions_overview': {
      const groups = await (prisma as any).missions.groupBy({ by: ['status'], _count: { id: true } });
      const rows: ReportRow[] = groups.map((g: any) => ({ label: g.status, value: g._count.id }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'donut', title: 'Missions Overview by Status' },
      };
    }

    case 'proactive_by_resource': {
      const groups = await prisma.activities.groupBy({
        by: ['assigned_resource_id'],
        where: { channel: 'proactive' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      });
      const ids = groups.map((g: any) => g.assigned_resource_id).filter(Boolean);
      const resources: any[] = ids.length
        ? await prisma.ai_resources.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
      const nameMap = Object.fromEntries(resources.map((r: any) => [r.id, r.name]));
      const rows: ReportRow[] = groups.map((g: any) => ({
        label: g.assigned_resource_id ? (nameMap[g.assigned_resource_id] ?? g.assigned_resource_id) : '(unassigned)',
        value: g._count.id,
      }));
      return {
        report: reportKey,
        columns: ['label', 'value'],
        rows,
        suggestedChart: { type: 'bar', title: 'Proactive Activities by Resource (Top 10)' },
      };
    }

    default:
      throw new BadRequestException(`Unknown report key: "${reportKey}". Valid keys: activities_by_status, activities_by_resource, approvals_by_status, tasks_by_status, missions_overview, proactive_by_resource`);
  }
}

export const REPORT_CATALOG_KEYS = [
  'activities_by_status',
  'activities_by_resource',
  'approvals_by_status',
  'tasks_by_status',
  'missions_overview',
  'proactive_by_resource',
] as const;
