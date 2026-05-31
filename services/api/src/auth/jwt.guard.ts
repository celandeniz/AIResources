import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC, ROLES_KEY, AuthUser } from './decorators';
import { ROLE_RANK, UserRole } from '@dynops/shared';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    // Internal service-to-service calls (worker → api) use a shared token.
    const internal = req.headers['x-internal-token'];
    if (internal && internal === (process.env.INTERNAL_TOKEN ?? 'dev-internal-token')) {
      req.user = { id: 'system', email: 'system', display_name: 'system', role: 'admin', approval_limit: null } as AuthUser;
      return true;
    }

    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query?.access_token as string | undefined) ?? null;
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_SECRET ?? 'dev-only-change-me' });
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.prisma.users.findUnique({ where: { id: payload.sub } });
    if (!user || !user.is_active) throw new UnauthorizedException('Unknown user');
    req.user = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      approval_limit: user.approval_limit ? Number(user.approval_limit) : null,
    } as AuthUser;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (required?.length) {
      const min = Math.min(...required.map((r) => ROLE_RANK[r]));
      if (ROLE_RANK[user.role] < min) throw new ForbiddenException('Insufficient role');
    }
    // Workspace/ALS is established by TenantMiddleware (runs before guards).
    return true;
  }
}
