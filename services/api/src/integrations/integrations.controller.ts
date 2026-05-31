import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../common/audit.service';
import { ExecutorService } from './executor.service';
import { getAdapter } from './mock-adapters';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { GraphTeamsAdapter } from './graph/graph-teams.adapter';
import { graphConfigured } from './graph/graph-client';
import { Roles } from '../auth/decorators';
import { IntegrationKind } from '@dynops/shared';

const TYPE_TO_KIND: Record<string, IntegrationKind> = {
  graph_email: 'email',
  graph_calendar: 'calendar',
  graph_teams: 'teams',
  ado_org: 'devops',
  github: 'github',
  opsconnect: 'opsconnect',
  business_central: 'business_central',
  crm: 'crm',
  sharepoint: 'internal',
};

@Controller('integrations')
class IntegrationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('admin')
  list() {
    return this.prisma.integrations.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  }

  @Get(':id')
  @Roles('admin')
  get(@Param('id') id: string) {
    return this.prisma.integrations.findUnique({ where: { id } });
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id') id: string, @Body() body: any) {
    return this.prisma.integrations.update({ where: { id }, data: body });
  }

  @Post(':id/test')
  @Roles('admin')
  async test(@Param('id') id: string) {
    const row = await this.prisma.integrations.findUnique({ where: { id } });
    if (!row) return { ok: false, detail: 'not found' };
    const kind = TYPE_TO_KIND[row.type] ?? 'internal';
    const conn = { id: row.id, type: row.type, name: row.name, config: (row.config as any) ?? {}, isMock: row.is_mock };
    let adapter: any = getAdapter(kind);
    if (!row.is_mock && graphConfigured()) {
      if (kind === 'email') adapter = new GraphEmailAdapter();
      else if (kind === 'teams') adapter = new GraphTeamsAdapter();
    }
    return adapter.healthCheck(conn);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [IntegrationsController],
  providers: [ExecutorService],
  exports: [ExecutorService],
})
export class IntegrationsModule {}
