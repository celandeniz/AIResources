import { BadRequestException, Body, Controller, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';

@Controller('skills')
class SkillsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return (this.prisma as any).skills.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  @Roles('admin')
  @Post()
  async create(@Body() body: { key: string; name: string; description?: string; prompt_fragment: string; tools?: string[] }) {
    if (!body?.key?.trim()) throw new BadRequestException('key is required');
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    if (!body?.prompt_fragment?.trim()) throw new BadRequestException('prompt_fragment is required');
    return (this.prisma as any).skills.create({
      data: {
        workspace_id: currentWorkspaceId() ?? undefined,
        key: body.key.trim(),
        name: body.name.trim(),
        description: body.description ?? null,
        prompt_fragment: body.prompt_fragment,
        tools: (body.tools ?? []) as any,
        is_active: true,
      },
    });
  }

  @Roles('admin')
  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: { name?: string; description?: string; prompt_fragment?: string; tools?: string[]; is_active?: boolean }) {
    const existing = await (this.prisma as any).skills.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('skill not found');
    return (this.prisma as any).skills.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.prompt_fragment !== undefined ? { prompt_fragment: body.prompt_fragment } : {}),
        ...(body.tools !== undefined ? { tools: body.tools as any } : {}),
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
      },
    });
  }
}

@Controller('ai-resources')
class ResourceSkillsController {
  constructor(private readonly prisma: PrismaService) {}

  @Roles('manager')
  @Post(':id/attach-skill')
  async attachSkill(@Param('id') id: string, @Body() body: { skillKey: string }) {
    if (!body?.skillKey?.trim()) throw new BadRequestException('skillKey is required');
    const resource = await this.prisma.ai_resources.findUnique({ where: { id } });
    if (!resource) throw new BadRequestException('resource not found');
    const skill = await (this.prisma as any).skills.findUnique({ where: { key: body.skillKey } });
    if (!skill) throw new BadRequestException(`skill "${body.skillKey}" not found`);

    const cfg = (resource.config as Record<string, unknown>) ?? {};
    const existing: string[] = Array.isArray((cfg as any).skills) ? (cfg as any).skills : [];
    if (!existing.includes(body.skillKey)) {
      const updated = { ...cfg, skills: [...existing, body.skillKey] };
      await this.prisma.ai_resources.update({ where: { id }, data: { config: updated as any } });
    }
    return { ok: true, skills: Array.isArray((cfg as any).skills) ? [...(cfg as any).skills, body.skillKey] : [body.skillKey] };
  }

  @Roles('manager')
  @Post(':id/detach-skill')
  async detachSkill(@Param('id') id: string, @Body() body: { skillKey: string }) {
    if (!body?.skillKey?.trim()) throw new BadRequestException('skillKey is required');
    const resource = await this.prisma.ai_resources.findUnique({ where: { id } });
    if (!resource) throw new BadRequestException('resource not found');

    const cfg = (resource.config as Record<string, unknown>) ?? {};
    const existing: string[] = Array.isArray((cfg as any).skills) ? (cfg as any).skills : [];
    const updated = { ...cfg, skills: existing.filter((k) => k !== body.skillKey) };
    await this.prisma.ai_resources.update({ where: { id }, data: { config: updated as any } });
    return { ok: true, skills: updated.skills };
  }
}

@Module({ controllers: [SkillsController, ResourceSkillsController] })
export class SkillsModule {}
