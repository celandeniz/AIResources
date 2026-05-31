import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

@Controller()
class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  // Draft feedback loop (👍/👎) — feeds resource scorecards & prompt tuning.
  @Post('agent-runs/:id/feedback')
  @Roles('consultant')
  async feedback(@Param('id') id: string, @Body() body: { rating: 'up' | 'down'; note?: string }, @CurrentUser() user: AuthUser) {
    return this.prisma.agent_feedback.create({
      data: { agent_run_id: id, user_id: user.id, rating: body.rating, note: body.note ?? null },
    });
  }

  @Get('agent-runs/:id/feedback')
  feedbackFor(@Param('id') id: string) {
    return this.prisma.agent_feedback.findMany({ where: { agent_run_id: id }, orderBy: { created_at: 'desc' } });
  }

  @Get('agent-runs')
  @Roles('manager')
  runs(@Query() q: any) {
    const where: any = {};
    if (q.activityId) where.activity_id = q.activityId;
    if (q.aiResourceId) where.ai_resource_id = q.aiResourceId;
    return this.prisma.agent_runs.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 200,
      include: { ai_resource: { select: { name: true, key: true } }, tool_calls: true },
    });
  }

  @Get('agent-runs/:id')
  @Roles('manager')
  run(@Param('id') id: string) {
    return this.prisma.agent_runs.findUnique({ where: { id }, include: { tool_calls: true, ai_resource: true } });
  }

  @Get('audit-logs')
  @Roles('manager')
  logs(@Query() q: any) {
    const where: any = {};
    if (q.actorType) where.actor_type = q.actorType;
    if (q.action) where.action = q.action;
    if (q.entity) where.entity_type = q.entity;
    if (q.activityId) where.activity_id = q.activityId;
    return this.prisma.audit_logs.findMany({ where, orderBy: { created_at: 'desc' }, take: 300 });
  }

  @Get('audit-logs/:id')
  @Roles('manager')
  log(@Param('id') id: string) {
    return this.prisma.audit_logs.findUnique({ where: { id } });
  }
}

@Module({ controllers: [AuditController] })
export class AuditReadModule {}
