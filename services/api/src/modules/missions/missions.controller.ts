import { BadRequestException, Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

// Mission Pods — goal-driven multi-agent teams. POST a goal → the worker plans a
// dependency-aware task graph and drives it to completion through the normal
// draft-first pipeline; this controller exposes create + read for the war-room UI.
@Controller('missions')
class MissionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  list() {
    return (this.prisma as any).missions.findMany({
      orderBy: { created_at: 'desc' },
      take: 50,
      include: { lead_resource: { select: { id: true, name: true, key: true } }, _count: { select: { tasks: true } } },
    });
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const mission = await (this.prisma as any).missions.findUnique({
      where: { id },
      include: { lead_resource: { select: { id: true, name: true, key: true } } },
    });
    if (!mission) throw new BadRequestException('not found');
    const tasks = await this.prisma.tasks.findMany({
      where: { mission_id: id },
      orderBy: { sequence: 'asc' },
      include: { assignee_resource: { select: { id: true, name: true, key: true } } },
    });
    const messages = await (this.prisma as any).agent_messages.findMany({
      where: { mission_id: id },
      orderBy: { created_at: 'asc' },
      include: { from_resource: { select: { name: true, key: true } } },
    });
    return { ...mission, tasks, messages };
  }

  @Roles('manager')
  @Post()
  async create(@Body() body: { title: string; goal: string; lead_resource_id?: string }, @CurrentUser() user: AuthUser) {
    if (!body?.goal?.trim()) throw new BadRequestException('goal is required');
    const mission = await (this.prisma as any).missions.create({
      data: {
        title: (body.title || body.goal).slice(0, 240),
        goal: body.goal,
        status: 'planning',
        lead_resource_id: body.lead_resource_id ?? null,
        created_by: user.id,
      },
    });
    await this.queue.enqueueMission(mission.id);
    return { id: mission.id, status: mission.status };
  }

  // ── Plan Canvas (ECC): human review of a gated plan before execution ───────
  // Dev-pod templates plan their stage graph but stay in 'planning' with
  // summary.plan_pending=true; the manager can edit tasks, then approve. The
  // worker's planAndStartMission short-circuits to executeReadyTasks for
  // missions already 'running'.
  @Roles('manager')
  @Post(':id/approve-plan')
  async approvePlan(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const mission = await (this.prisma as any).missions.findUnique({ where: { id } });
    if (!mission) throw new BadRequestException('not found');
    const summary = (mission.summary as any) ?? {};
    if (mission.status !== 'planning' || !summary.plan_pending) {
      throw new BadRequestException('mission has no pending plan');
    }
    await (this.prisma as any).missions.update({
      where: { id },
      data: {
        status: 'running',
        summary: { ...summary, plan_pending: false, plan_approved_by: user.id, plan_approved_at: new Date().toISOString() },
      },
    });
    await this.queue.enqueueMission(id); // worker resumes: running → executeReadyTasks
    return { ok: true, status: 'running' };
  }

  @Roles('manager')
  @Post(':id/reject-plan')
  async rejectPlan(@Param('id') id: string, @Body() body: { note?: string }) {
    const mission = await (this.prisma as any).missions.findUnique({ where: { id } });
    if (!mission) throw new BadRequestException('not found');
    const summary = (mission.summary as any) ?? {};
    if (mission.status !== 'planning' || !summary.plan_pending) {
      throw new BadRequestException('mission has no pending plan');
    }
    await (this.prisma as any).missions.update({
      where: { id },
      data: { status: 'failed', summary: { ...summary, plan_pending: false, plan_rejected: true, plan_note: body?.note ?? null } },
    });
    return { ok: true, status: 'failed' };
  }

  // Plan Canvas task edits while the plan is pending.
  @Roles('manager')
  @Post(':id/tasks/:taskId')
  async editPlanTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: { title?: string; description?: string; assignee_resource_id?: string | null; remove?: boolean },
  ) {
    const mission = await (this.prisma as any).missions.findUnique({ where: { id } });
    if (!mission || !((mission.summary as any) ?? {}).plan_pending) {
      throw new BadRequestException('plan is not editable (not pending)');
    }
    const task = await this.prisma.tasks.findUnique({ where: { id: taskId } });
    if (!task || task.mission_id !== id) throw new BadRequestException('task not in this mission');
    if (body.remove) {
      // Detach dependents so the graph stays executable, then delete.
      const siblings = await this.prisma.tasks.findMany({ where: { mission_id: id } });
      for (const s of siblings) {
        const deps = ((s.depends_on as string[]) ?? []).filter((d) => d !== taskId);
        if (deps.length !== ((s.depends_on as string[]) ?? []).length) {
          await this.prisma.tasks.update({ where: { id: s.id }, data: { depends_on: deps } });
        }
      }
      await this.prisma.tasks.delete({ where: { id: taskId } });
      return { ok: true, removed: true };
    }
    const data: any = {};
    if (body.title) data.title = String(body.title).slice(0, 300);
    if (body.description !== undefined) data.description = body.description;
    if (body.assignee_resource_id !== undefined) data.assignee_resource_id = body.assignee_resource_id;
    return this.prisma.tasks.update({ where: { id: taskId }, data });
  }
}

@Module({ controllers: [MissionsController] })
export class MissionsModule {}
