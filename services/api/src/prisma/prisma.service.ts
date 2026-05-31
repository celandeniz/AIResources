import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@dynops/db';
import { currentWorkspaceId, TENANT_MODELS } from '../common/tenant';

// Tenant-isolation extension — the single choke point. When a workspace context
// is active (set by JwtAuthGuard via AsyncLocalStorage), every list/search/
// aggregate/mutation on a tenant model is automatically scoped to that workspace,
// and creates are stamped with workspace_id. Cross-workspace leakage is structurally
// prevented for the user-facing query surface.
function tenantGuard() {
  return {
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const ws = currentWorkspaceId();
          if (!ws || !TENANT_MODELS.has(model)) return query(args);
          switch (operation) {
            case 'findMany':
            case 'findFirst':
            case 'findFirstOrThrow':
            case 'count':
            case 'aggregate':
            case 'groupBy':
            case 'updateMany':
            case 'deleteMany':
            case 'findUnique':
            case 'findUniqueOrThrow':
            case 'update':
            case 'delete':
              args.where = { ...(args.where ?? {}), workspace_id: ws };
              break;
            case 'create':
              args.data = { ...(args.data ?? {}), workspace_id: ws };
              break;
            case 'createMany': {
              const d = args.data;
              args.data = Array.isArray(d) ? d.map((x: any) => ({ ...x, workspace_id: ws })) : { ...d, workspace_id: ws };
              break;
            }
            case 'upsert':
              args.create = { ...(args.create ?? {}), workspace_id: ws };
              break;
          }
          return query(args);
        },
      },
    },
  } as any;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);
  private readonly extended: any;

  constructor() {
    super();
    this.extended = this.$extends(tenantGuard());
    // Route tenant-model delegate access through the scoped client; everything
    // else ($connect, $extends, raw, lifecycle) stays on the base instance.
    return new Proxy(this, {
      get: (target: any, prop: string) => {
        if (typeof prop === 'string' && TENANT_MODELS.has(prop)) return (this.extended as any)[prop];
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
    await this.enforceAuditAppendOnly();
  }

  private async enforceAuditAppendOnly() {
    try {
      await this.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
        RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;`);
      await this.$executeRawUnsafe(`DROP TRIGGER IF EXISTS trg_audit_logs_no_mutation ON audit_logs;`);
      await this.$executeRawUnsafe(`
        CREATE TRIGGER trg_audit_logs_no_mutation BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();`);
      this.logger.log('audit_logs append-only trigger ensured');
    } catch (e) {
      this.logger.warn(`Could not ensure audit trigger: ${(e as Error).message}`);
    }
  }
}
