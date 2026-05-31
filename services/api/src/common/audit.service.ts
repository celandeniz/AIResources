import { Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type AuditAction =
  | 'create' | 'update' | 'delete' | 'login' | 'route' | 'draft'
  | 'approve' | 'reject' | 'execute' | 'escalate' | 'ingest' | 'index';

export interface AuditInput {
  actorType: 'user' | 'ai_resource' | 'system';
  actorUserId?: string | null;
  actorResourceId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  activityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditInput) {
    return this.prisma.audit_logs.create({
      data: {
        actor_type: input.actorType,
        actor_user_id: input.actorUserId ?? null,
        actor_resource_id: input.actorResourceId ?? null,
        action: input.action,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        activity_id: input.activityId ?? null,
        summary: input.summary ?? null,
        before: (input.before as any) ?? undefined,
        after: (input.after as any) ?? undefined,
        metadata: (input.metadata as any) ?? {},
      },
    });
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
