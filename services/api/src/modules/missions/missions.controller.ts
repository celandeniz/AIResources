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
}

@Module({ controllers: [MissionsController] })
export class MissionsModule {}
