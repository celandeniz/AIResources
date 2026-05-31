import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { tenantStore } from './tenant';

// Resolves the active workspace and runs the ENTIRE request inside
// tenantStore.run() so the Prisma tenant-guard sees the workspace for every
// query (run() propagates reliably across async boundaries; enterWith() does not).
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async use(req: any, _res: any, next: () => void) {
    let store: { workspaceId?: string; userId?: string; role?: string } = {};
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query?.access_token as string | undefined) ?? null;
    if (token) {
      try {
        const payload: any = await this.jwt.verifyAsync(token, { secret: process.env.JWT_SECRET ?? 'dev-only-change-me' });
        const requested = (req.headers['x-workspace'] as string) || (req.query?.workspace as string) || undefined;
        const memberships = await this.prisma.memberships.findMany({ where: { user_id: payload.sub } });
        let workspaceId: string | undefined;
        if (requested && memberships.some((m) => m.workspace_id === requested)) workspaceId = requested;
        else if (memberships.length) workspaceId = memberships[0].workspace_id;
        store = { workspaceId, userId: payload.sub, role: payload.role };
        req.workspaceId = workspaceId;
      } catch {
        /* invalid token — guard will reject; run unscoped */
      }
    }
    tenantStore.run(store, () => next());
  }
}
