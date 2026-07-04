import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { PhoneStep } from './phone-task.types';

export const PHONE_COMMAND_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class PhoneTaskService {
  private readonly logger = new Logger(PhoneTaskService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Mirrors the worker write-back approval chain:
  // synthetic agent_run -> tool_call(awaiting_approval) -> approval(pending),
  // plus the M3-specific sibling row in device_commands. This never executes
  // anything; the device only runs the script after the approval hook marks the
  // command approved.
  async propose(params: {
    userId: string;
    workspaceId: string | null;
    kind: string;
    steps: PhoneStep[];
    reason?: string;
    aiResourceId?: string | null;
    activityId?: string | null;
  }): Promise<{ deviceCommandId: string; approvalId: string }> {
    const { userId, workspaceId, kind, steps, reason, aiResourceId } = params;

    let activityId = params.activityId ?? null;
    if (!activityId) {
      const activity = await this.prisma.activities.create({
        data: {
          workspace_id: workspaceId ?? undefined,
          channel: 'manual',
          subject: `Phone task: ${kind}`,
          status: 'awaiting_approval',
          requires_approval: true,
          metadata: { source: 'phone_task' } as any,
        },
      });
      activityId = activity.id;
    }

    let resourceId = aiResourceId ?? null;
    if (!resourceId) {
      const anyResource = await this.prisma.ai_resources.findFirst({
        where: { status: 'active', workspace_id: workspaceId ?? undefined },
      });
      if (!anyResource) {
        throw new Error('phone_task propose: no active ai_resource available for agent_run attribution');
      }
      resourceId = anyResource.id;
    }

    const command = await (this.prisma as any).device_commands.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'proposed',
        kind,
        payload: steps as any,
      },
    });

    const agentRun = await this.prisma.agent_runs.create({
      data: {
        workspace_id: workspaceId ?? undefined,
        activity_id: activityId,
        ai_resource_id: resourceId,
        llm_provider: 'ollama',
        llm_model: 'qwen3',
        status: 'succeeded',
        input: { device_command_id: command.id, kind } as any,
        output: {} as any,
        tools_used: ['phone_task'] as any,
        finished_at: new Date(),
      },
    });

    const toolCall = await this.prisma.tool_calls.create({
      data: {
        workspace_id: workspaceId ?? undefined,
        agent_run_id: agentRun.id,
        name: 'phone_task',
        args: { device_command_id: command.id, kind, steps } as any,
        requires_approval: true,
        risk_level: 'high',
        status: 'awaiting_approval',
        sequence: 0,
      },
    });

    const approval = await this.prisma.approvals.create({
      data: {
        workspace_id: workspaceId ?? undefined,
        activity_id: activityId,
        agent_run_id: agentRun.id,
        tool_call_id: toolCall.id,
        action: 'phone_task',
        payload: { device_command_id: command.id, kind, steps } as any,
        risk_level: 'high',
        reason: reason ?? `Phone task: ${kind}`,
        status: 'pending',
      },
    });

    await (this.prisma as any).device_commands.update({
      where: { id: command.id },
      data: { status: 'awaiting_approval', agent_run_id: agentRun.id },
    });

    this.logger.log(`Proposed phone_task ${command.id} (${kind}) -> approval ${approval.id}`);
    return { deviceCommandId: command.id, approvalId: approval.id };
  }
}
