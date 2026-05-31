import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsEmail, IsIn, IsOptional } from 'class-validator';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { Public, CurrentUser, AuthUser } from './decorators';
import { USER_ROLES, UserRole } from '@dynops/shared';

class DevLoginDto {
  @IsEmail() email!: string;
  @IsOptional() @IsIn(USER_ROLES as unknown as string[]) role?: UserRole;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('dev-login')
  devLogin(@Body() dto: DevLoginDto) {
    return this.auth.devLogin(dto.email, dto.role);
  }

  @Public()
  @Get('login')
  login() {
    // In AUTH_MODE=entra this would 302 to Entra; the dev stub returns guidance.
    return { mode: process.env.AUTH_MODE ?? 'dev', hint: 'POST /api/v1/auth/dev-login { email, role }' };
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const perms = await this.prisma.permissions.findMany({
      where: { OR: [{ subject_user_id: user.id }, { subject_role: user.role }] },
    });
    return { ...this.auth.publicUser({ ...user, display_name: user.display_name } as any), permissions: perms };
  }

  @Post('logout')
  logout() {
    return { ok: true };
  }
}
