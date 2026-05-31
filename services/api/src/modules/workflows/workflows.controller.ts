import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';

@Controller()
class WorkflowsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('workflows')
  @Roles('manager')
  workflows() {
    return this.prisma.workflows.findMany({ orderBy: { priority: 'asc' }, include: { rules: true } });
  }

  @Get('workflow-rules')
  @Roles('manager')
  rules(@Query('workflowId') workflowId?: string) {
    return this.prisma.workflow_rules.findMany({
      where: workflowId ? { workflow_id: workflowId } : {},
      orderBy: { priority: 'asc' },
      include: { target_resource: { select: { key: true, name: true } } },
    });
  }

  @Post('workflow-rules')
  @Roles('manager')
  createRule(@Body() body: any) {
    return this.prisma.workflow_rules.create({ data: body });
  }

  @Patch('workflow-rules/:id')
  @Roles('manager')
  updateRule(@Param('id') id: string, @Body() body: any) {
    return this.prisma.workflow_rules.update({ where: { id }, data: body });
  }

  @Delete('workflow-rules/:id')
  @Roles('manager')
  deleteRule(@Param('id') id: string) {
    return this.prisma.workflow_rules.delete({ where: { id } });
  }
}

@Module({ controllers: [WorkflowsController] })
export class WorkflowsModule {}
