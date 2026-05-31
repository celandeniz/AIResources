import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExecutorService } from '../../integrations/executor.service';
import { Roles } from '../../auth/decorators';

@Controller('tool-calls')
export class ToolCallsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: ExecutorService,
  ) {}

  @Get()
  @Roles('manager')
  list(@Query() q: any) {
    const where: any = {};
    if (q.status) where.status = q.status;
    if (q.name) where.name = q.name;
    return this.prisma.tool_calls.findMany({ where, orderBy: { created_at: 'desc' }, take: 200 });
  }

  @Get(':id')
  @Roles('manager')
  get(@Param('id') id: string) {
    return this.prisma.tool_calls.findUnique({ where: { id } });
  }

  // Internal: the worker calls this to execute auto-approved (non-sensitive) tool calls.
  // Protected by the internal-token path in JwtAuthGuard (role=admin).
  @Roles('admin')
  @Post(':id/execute')
  execute(@Param('id') id: string) {
    return this.executor.executeToolCall(id, null);
  }
}
