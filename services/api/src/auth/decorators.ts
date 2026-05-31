import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@dynops/shared';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  approval_limit: number | null;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest();
  return req.user;
});
