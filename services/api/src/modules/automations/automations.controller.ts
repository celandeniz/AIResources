import { Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { Roles } from '../../auth/decorators';

// Proactive recurring department jobs. Each automation, on its cadence (or via
// "Run now"), spawns a synthetic `proactive` activity (pinned to its resource)
// that flows through the normal draft-first pipeline and hands off across
// departments. The worker owns the scheduler + the proactive.run processor.
@Controller('automations')
class AutomationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  @Get()
  list() {
    return (this.prisma as any).automations.findMany({
      orderBy: [{ resource_id: 'asc' }, { name: 'asc' }],
      include: { resource: { select: { id: true, name: true, key: true, email: true, llm_model: true, config: true } } },
    });
  }

  @Roles('manager')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { is_active?: boolean; objective?: string; cadence?: string }) {
    const data: Record<string, unknown> = {};
    if (typeof body.is_active === 'boolean') data.is_active = body.is_active;
    if (typeof body.objective === 'string') data.objective = body.objective;
    if (typeof body.cadence === 'string') data.cadence = body.cadence;
    return (this.prisma as any).automations.update({ where: { id }, data });
  }

  // Trigger a single proactive run immediately (does not change the cadence).
  @Roles('manager')
  @Post(':id/run')
  async run(@Param('id') id: string) {
    const a = await (this.prisma as any).automations.findUnique({ where: { id } });
    if (!a) return { ok: false, error: 'not found' };
    await this.queue.enqueueProactive(id);
    return { ok: true, queued: id };
  }
}

@Module({ controllers: [AutomationsController] })
export class AutomationsModule {}
