import { BadRequestException, Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import type { AgentRunRequest, AgentRunResponse } from '@dynops/shared';
import { TOOL_REGISTRY, isKnownTool } from '@dynops/shared';
import { CurrentUser, AuthUser } from '../../auth/decorators';
import { AuditService } from '../../common/audit.service';
import { emitStreamEvent } from '../../common/events';
import { currentWorkspaceId } from '../../common/tenant';
import { PrismaService } from '../../prisma/prisma.service';

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

async function runChatAgent(req: AgentRunRequest): Promise<AgentRunResponse> {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<AgentRunResponse>;
}

@Controller('chat')
class ChatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('threads')
  async threads(@CurrentUser() _user: AuthUser) {
    const wsId = currentWorkspaceId();
    const rows = await this.prisma.activities.findMany({
      where: { channel: 'chat', ...(wsId ? { workspace_id: wsId } : {}) },
      orderBy: { updated_at: 'desc' },
      take: 100,
      include: {
        assigned_resource: { select: { id: true, key: true, name: true } },
        messages: { orderBy: { created_at: 'desc' }, take: 1 },
      },
    });

    return rows.map((activity) => ({
      id: activity.id,
      subject: activity.subject,
      status: activity.status,
      resource: activity.assigned_resource
        ? {
            id: activity.assigned_resource.id,
            key: activity.assigned_resource.key,
            name: activity.assigned_resource.name,
          }
        : null,
      last_message: activity.messages[0]?.body ?? null,
      last_message_at: activity.messages[0]?.created_at ?? activity.updated_at,
      updated_at: activity.updated_at,
    }));
  }

  @Get('threads/:id/messages')
  async threadMessages(@Param('id') id: string) {
    const wsId = currentWorkspaceId();
    const activity = await this.prisma.activities.findFirst({
      where: { id, channel: 'chat', ...(wsId ? { workspace_id: wsId } : {}) },
    });
    if (!activity) throw new BadRequestException('chat thread not found');

    const messages = await this.prisma.messages.findMany({
      where: { activity_id: id, ...(wsId ? { workspace_id: wsId } : {}) },
      orderBy: { created_at: 'asc' },
    });

    return {
      thread: {
        id: activity.id,
        subject: activity.subject,
        status: activity.status,
        resource_id: activity.assigned_resource_id,
      },
      messages: messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        author_type: message.author_type,
        body: message.body,
        is_draft: message.is_draft,
        created_at: message.created_at,
      })),
    };
  }

  @Post()
  async send(
    @Body() body: { resource_key?: string; message?: string; thread_id?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const text = body.message?.trim();
    if (!text) throw new BadRequestException('message is required');

    const wsId = currentWorkspaceId();
    let activity = body.thread_id
      ? await this.prisma.activities.findFirst({
          where: { id: body.thread_id, channel: 'chat', ...(wsId ? { workspace_id: wsId } : {}) },
        })
      : null;
    if (body.thread_id && !activity) throw new BadRequestException('chat thread not found');

    const resource = activity?.assigned_resource_id
      ? await this.prisma.ai_resources.findFirst({
          where: { id: activity.assigned_resource_id, ...(wsId ? { workspace_id: wsId } : {}) },
        })
      : await this.prisma.ai_resources.findFirst({
          where: {
            status: 'active',
            ...(wsId ? { workspace_id: wsId } : {}),
            OR: [
              { key: body.resource_key ?? '' },
              { name: { contains: body.resource_key ?? '', mode: 'insensitive' } },
            ],
          },
        });
    if (!resource) throw new BadRequestException(`No active resource matching "${body.resource_key ?? ''}".`);

    if (!activity) {
      activity = await this.prisma.activities.create({
        data: {
          workspace_id: wsId,
          channel: 'chat',
          subject: text.slice(0, 120),
          body: text,
          status: 'in_progress',
          priority: 'normal',
          assigned_resource_id: resource.id,
          assigned_user_id: user.id,
          metadata: { source: 'mobile_chat', started_by: user.id } as any,
        },
      });
    }

    await this.prisma.messages.create({
      data: {
        workspace_id: wsId,
        activity_id: activity.id,
        direction: 'inbound',
        channel: 'chat',
        author_type: 'user',
        author_user_id: user.id,
        body: text,
      },
    });

    const priorMessages = await this.prisma.messages.findMany({
      where: { activity_id: activity.id, ...(wsId ? { workspace_id: wsId } : {}) },
      orderBy: { created_at: 'asc' },
      take: 40,
    });

    const agentRequest: AgentRunRequest = {
      run_id: `chat-${activity.id}-${Date.now()}`,
      workspace_id: wsId,
      ai_resource: {
        key: resource.key,
        name: resource.name,
        system_prompt: resource.system_prompt,
        provider: resource.llm_provider,
        model: resource.llm_model,
        temperature: Number(resource.temperature),
        tools: Array.isArray(resource.allowed_tools) ? (resource.allowed_tools as string[]) : [],
        confidence_threshold: Number(resource.confidence_threshold),
      },
      activity: {
        id: activity.id,
        channel: 'chat',
        subject: activity.subject,
        body: text,
        priority: 'normal',
        customer: null,
      },
      context: {
        thread: priorMessages.map((message) => ({
          role: message.direction === 'inbound' ? 'external' : 'internal',
          at: message.created_at.toISOString(),
          text: message.body ?? '',
        })),
        rag_hints: [],
        rag_hits: [],
      },
      options: { max_tool_intents: 5 },
    };

    let agentResponse: AgentRunResponse;
    try {
      agentResponse = await runChatAgent(agentRequest);
    } catch (error) {
      throw new BadRequestException(`Agent call failed: ${(error as Error).message}`);
    }

    const replyText = agentResponse.draft.content.trim() || '(yanıt üretilemedi)';
    const confidence = agentResponse.confidence ?? 0.5;
    const threshold = Number(resource.confidence_threshold);
    const approvalLimit = resource.approval_limit !== null ? Number(resource.approval_limit) : null;

    await this.prisma.messages.create({
      data: {
        workspace_id: wsId,
        activity_id: activity.id,
        direction: 'outbound',
        channel: 'chat',
        author_type: 'ai_resource',
        author_resource_id: resource.id,
        body: replyText,
      },
    });

    let toolIntentsPending = false;
    if (agentResponse.tool_intents.length > 0) {
      const run = await this.prisma.agent_runs.create({
        data: {
          workspace_id: wsId,
          activity_id: activity.id,
          ai_resource_id: resource.id,
          llm_provider: resource.llm_provider,
          llm_model: resource.llm_model,
          input: agentRequest as any,
          output: agentResponse as any,
          reasoning_summary: agentResponse.reasoning_summary,
          confidence_score: confidence,
          status: 'succeeded',
          started_at: new Date(),
          finished_at: new Date(),
        },
      });

      let sequence = 0;
      for (const intent of agentResponse.tool_intents) {
        const definition = isKnownTool(intent.tool) ? TOOL_REGISTRY[intent.tool] : undefined;
        const sensitive = definition?.sensitive ?? intent.sensitive ?? false;
        const risk = definition?.risk ?? 'medium';
        const monetary = definition?.monetary ?? false;
        const amount = monetary && typeof intent.args?.amount === 'number' ? intent.args.amount : null;
        const overLimit = amount !== null && approvalLimit !== null && amount > approvalLimit;
        const requiresApproval = sensitive || agentResponse.needs_escalation || confidence < threshold || overLimit;

        const toolCall = await this.prisma.tool_calls.create({
          data: {
            workspace_id: wsId,
            agent_run_id: run.id,
            name: intent.tool,
            args: (intent.args ?? {}) as any,
            requires_approval: requiresApproval,
            risk_level: risk,
            status: requiresApproval ? 'awaiting_approval' : 'approved',
            sequence: sequence++,
          },
        });

        if (requiresApproval) {
          toolIntentsPending = true;
          await this.prisma.approvals.create({
            data: {
              workspace_id: wsId,
              activity_id: activity.id,
              agent_run_id: run.id,
              tool_call_id: toolCall.id,
              action: intent.tool,
              payload: (intent.args ?? {}) as any,
              risk_level: risk,
              amount: amount ?? undefined,
              reason: agentResponse.needs_escalation
                ? 'escalation'
                : confidence < threshold
                  ? 'low_confidence'
                  : 'sensitive_action',
              status: 'pending',
              requested_by_id: user.id,
            },
          });
          await this.prisma.notifications.create({
            data: {
              workspace_id: wsId,
              type: 'approval_created',
              title: `Approval required: ${intent.tool}`,
              message: `${resource.name} proposed ${intent.tool} from a chat with ${user.display_name}.`,
              metadata: { activityId: activity.id, agentRunId: run.id, toolCallId: toolCall.id } as any,
            },
          });
        }
      }
    }

    const updatedActivity = await this.prisma.activities.update({
      where: { id: activity.id },
      data: {
        status: toolIntentsPending ? 'awaiting_approval' : 'in_progress',
        requires_approval: toolIntentsPending,
        first_response_at: activity.first_response_at ?? new Date(),
      },
    });

    await this.audit.log({
      actorType: 'user',
      actorUserId: user.id,
      action: 'draft',
      entityType: 'activities',
      entityId: activity.id,
      activityId: activity.id,
      summary: `Chat turn with ${resource.name}${toolIntentsPending ? ' (tool approval pending)' : ''}`,
      metadata: { source: 'mobile_chat', tool_intents_pending: toolIntentsPending },
    });

    emitStreamEvent({ type: 'activity', workspaceId: wsId, payload: updatedActivity });

    return {
      thread_id: activity.id,
      reply: replyText,
      tool_intents_pending: toolIntentsPending,
    };
  }
}

@Module({ controllers: [ChatController] })
export class ChatModule {}
