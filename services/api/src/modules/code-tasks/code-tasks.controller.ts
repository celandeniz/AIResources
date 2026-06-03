import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';

// ─────────────────────────────────────────────────────────────────────────────
// CodeTasksController — approval-gated AI code-writing via OpenCode.
// Mirrors reports.controller's `createBcOrder`: a create builds a draft row +
// a synthetic activity/agent_run/tool_call/approval so the action surfaces in
// the Human Approval Center; on approve the executor drives OpenCode.
// ─────────────────────────────────────────────────────────────────────────────
@Controller('code-tasks')
class CodeTasksController {
  constructor(private readonly prisma: PrismaService) {}

  // ── GET /code-tasks ────────────────────────────────────────────────────────
  @Get()
  list() {
    const wsId = currentWorkspaceId();
    return (this.prisma as any).code_tasks.findMany({
      where: wsId ? { workspace_id: wsId } : {},
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        repo: true,
        model: true,
        agent: true,
        status: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  // ── GET /code-tasks/:id ──────────────────────────────────────────────────────
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const wsId = currentWorkspaceId();
    const row = await (this.prisma as any).code_tasks.findFirst({
      where: { id, ...(wsId ? { workspace_id: wsId } : {}) },
    });
    if (!row) throw new NotFoundException('code task not found');
    return row;
  }

  // ── POST /code-tasks ──────────────────────────────────────────────────────────
  @Roles('manager')
  @Post()
  async create(
    @Body() body: {
      title: string;
      repo?: string;
      instruction: string;
      model?: string;
      agent?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    const title = (body.title ?? '').trim();
    const instruction = (body.instruction ?? '').trim();
    if (!title) throw new BadRequestException('title is required');
    if (!instruction) throw new BadRequestException('instruction is required');

    const wsId = currentWorkspaceId();
    const model = body.model ?? null;
    const agent = body.agent ?? 'build';
    const repo = body.repo ?? null;

    // 0. Draft row
    const codeTask = await (this.prisma as any).code_tasks.create({
      data: {
        workspace_id: wsId ?? undefined,
        title: title.slice(0, 300),
        repo,
        instruction,
        model,
        agent,
        status: 'draft',
        created_by: user.id ?? null,
      },
    });

    // ── Approval-gated path (mirror reports.controller.createBcOrder) ─────────
    // Synthetic activity + agent_run satisfy the NOT NULL FK constraints on
    // tool_calls and approvals; the approval then appears in the Approval Center.

    // 1. Synthetic activity
    const activity = await this.prisma.activities.create({
      data: {
        workspace_id: wsId ?? undefined,
        channel: 'manual',
        subject: `AI Kod Görevi — ${title}`.slice(0, 480),
        body: instruction.slice(0, 4000),
        status: 'awaiting_approval',
        metadata: { source: 'code_task', code_task_id: codeTask.id } as any,
      },
    });

    // 2. Any active AI resource for the agent_run FK (prefer the AL Developer).
    const anyResource =
      (await this.prisma.ai_resources.findFirst({ where: { key: 'ai_al_developer', status: 'active' } })) ??
      (await this.prisma.ai_resources.findFirst({ where: { status: 'active' } }));
    if (!anyResource) {
      throw new BadRequestException('No active AI resource found; cannot create agent_run');
    }

    // 3. Synthetic agent_run
    const agentRun = await this.prisma.agent_runs.create({
      data: {
        workspace_id: wsId ?? undefined,
        activity_id: activity.id,
        ai_resource_id: anyResource.id,
        llm_provider: 'ollama',
        llm_model: 'qwen2.5-coder:14b',
        status: 'needs_approval',
        input: { code_task_id: codeTask.id, instruction } as any,
        output: {} as any,
        tools_used: ['code_task'] as any,
      },
    });

    // 4. Tool call
    const toolCall = await this.prisma.tool_calls.create({
      data: {
        workspace_id: wsId ?? undefined,
        agent_run_id: agentRun.id,
        name: 'code_task',
        args: {
          instruction,
          model,
          agent,
          repo,
          code_task_id: codeTask.id,
        } as any,
        requires_approval: true,
        risk_level: 'high',
        status: 'awaiting_approval',
        sequence: 0,
      },
    });

    // 5. Approval record
    const approval = await this.prisma.approvals.create({
      data: {
        workspace_id: wsId ?? undefined,
        activity_id: activity.id,
        agent_run_id: agentRun.id,
        tool_call_id: toolCall.id,
        action: 'code_task',
        payload: {
          title,
          repo,
          instruction,
          model,
          agent,
          code_task_id: codeTask.id,
        } as any,
        risk_level: 'high',
        reason: `AI kod görevi: ${title}`,
        status: 'pending',
        requested_by_id: user.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    return {
      ok: true,
      code_task_id: codeTask.id,
      approval_id: approval.id,
      message: 'Kod görevi onay talebi oluşturuldu — Onay Merkezi\'nde bekliyor.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────
@Module({
  controllers: [CodeTasksController],
})
export class CodeTasksModule {}
