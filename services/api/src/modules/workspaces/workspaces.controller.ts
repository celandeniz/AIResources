import { Body, Controller, Get, Param, Patch, Post, Module, Req } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule, AuditService } from '../../common/audit.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'workspace';
}

@Controller('workspaces')
class WorkspacesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Workspaces the current user belongs to.
  @Get()
  async mine(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.memberships.findMany({
      where: { user_id: user.id },
      include: { workspace: true },
      orderBy: { created_at: 'asc' },
    });
    return memberships.map((m) => ({ ...m.workspace, role: m.role }));
  }

  @Get('current')
  async current(@Req() req: any) {
    if (!req.workspaceId) return null;
    return this.prisma.workspaces.findUnique({ where: { id: req.workspaceId } });
  }

  // Create a new workspace (and make the creator an admin member).
  @Post()
  async create(@Body() body: { name: string; branding?: any }, @CurrentUser() user: AuthUser) {
    let slug = slugify(body.name);
    if (await this.prisma.workspaces.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const ws = await this.prisma.workspaces.create({ data: { name: body.name, slug, branding: body.branding ?? {} } });
    await this.prisma.memberships.create({ data: { workspace_id: ws.id, user_id: user.id, role: 'admin' } });
    return ws;
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Param('id') id: string, @Body() body: any) {
    return this.prisma.workspaces.update({ where: { id }, data: { name: body.name, branding: body.branding, plan: body.plan, limits: body.limits } });
  }

  @Get(':id/members')
  @Roles('manager')
  async members(@Param('id') id: string) {
    return this.prisma.memberships.findMany({ where: { workspace_id: id }, include: { user: { select: { email: true, display_name: true, role: true } } } });
  }

  @Post(':id/members')
  @Roles('admin')
  async invite(@Param('id') id: string, @Body() body: { email: string; role?: any }) {
    let user = await this.prisma.users.findUnique({ where: { email: body.email } });
    if (!user) user = await this.prisma.users.create({ data: { email: body.email, display_name: body.email.split('@')[0], role: body.role ?? 'consultant' } });
    const m = await this.prisma.memberships.upsert({
      where: { workspace_id_user_id: { workspace_id: id, user_id: user.id } },
      update: { role: body.role ?? 'consultant' },
      create: { workspace_id: id, user_id: user.id, role: body.role ?? 'consultant' },
    });
    return m;
  }
}

@Module({ imports: [AuditModule], controllers: [WorkspacesController] })
export class WorkspacesModule {}
