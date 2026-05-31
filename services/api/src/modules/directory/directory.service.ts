import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { currentWorkspaceId } from '../../common/tenant';

@Injectable()
export class DirectoryService {
  constructor(private readonly prisma: PrismaService) {}

  list(activeOnly?: boolean) {
    return this.prisma.ai_resources.findMany({
      where: activeOnly ? { status: 'active' } : {},
      orderBy: { name: 'asc' },
      include: { escalation_manager: { select: { display_name: true, email: true } } },
    });
  }

  async get(id: string) {
    const r = await this.prisma.ai_resources.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('resource not found');
    return r;
  }

  create(data: any) {
    return this.prisma.ai_resources.create({ data });
  }

  async update(id: string, data: any, userId?: string) {
    if (typeof data.system_prompt === 'string') {
      await this.createPromptVersion(id, data.system_prompt, userId);
      const { system_prompt, ...rest } = data;
      if (Object.keys(rest).length === 0) return this.get(id);
      data = rest;
    }
    return this.prisma.ai_resources.update({ where: { id }, data });
  }

  async toggleActive(id: string, active: boolean) {
    return this.prisma.ai_resources.update({ where: { id }, data: { status: active ? 'active' : 'paused' } });
  }

  async metrics(id: string) {
    const [runs, escalated, approvals] = await Promise.all([
      this.prisma.agent_runs.count({ where: { ai_resource_id: id } }),
      this.prisma.agent_runs.count({ where: { ai_resource_id: id, status: 'needs_approval' } }),
      this.prisma.agent_runs.aggregate({ where: { ai_resource_id: id }, _avg: { confidence_score: true, latency_ms: true } }),
    ]);
    return {
      handled: runs,
      escalations: escalated,
      avgConfidence: approvals._avg.confidence_score ? Number(approvals._avg.confidence_score) : null,
      avgResponseMs: approvals._avg.latency_ms ? Math.round(Number(approvals._avg.latency_ms)) : null,
    };
  }

  promptVersions(id: string) {
    return (this.prisma as any).prompt_versions.findMany({
      where: { ai_resource_id: id },
      orderBy: { version: 'desc' },
      take: 50,
    });
  }

  async createPromptVersion(id: string, systemPrompt: string, userId?: string) {
    const resource = await this.get(id);
    const latest = await (this.prisma as any).prompt_versions.findFirst({
      where: { ai_resource_id: id },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const row = await (this.prisma as any).prompt_versions.create({
      data: {
        workspace_id: currentWorkspaceId(),
        ai_resource_id: id,
        version,
        system_prompt: systemPrompt,
        created_by: userId ?? null,
      },
    });
    await this.prisma.ai_resources.update({ where: { id }, data: { system_prompt: systemPrompt } });
    return { ...row, previous_prompt: resource.system_prompt };
  }

  async rollbackPrompt(id: string, version: number, userId?: string) {
    const target = await (this.prisma as any).prompt_versions.findFirst({ where: { ai_resource_id: id, version } });
    if (!target) throw new NotFoundException('prompt version not found');
    return this.createPromptVersion(id, target.system_prompt, userId);
  }
}
