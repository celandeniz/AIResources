import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { UserRole } from '@dynops/shared';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // Local-only dev login. Disabled unless AUTH_MODE=dev.
  async devLogin(email: string, role?: UserRole) {
    if ((process.env.AUTH_MODE ?? 'dev') !== 'dev') {
      throw new UnauthorizedException('dev-login disabled (AUTH_MODE != dev)');
    }
    if (!email) throw new BadRequestException('email required');

    let user = await this.prisma.users.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.users.create({
        data: { email, display_name: email.split('@')[0], role: role ?? 'consultant' },
      });
    }
    await this.prisma.users.update({ where: { id: user.id }, data: { last_login_at: new Date() } });

    // Ensure the user belongs to at least one workspace (attach to the default).
    const membershipCount = await this.prisma.memberships.count({ where: { user_id: user.id } });
    if (membershipCount === 0) {
      const def =
        (await this.prisma.workspaces.findUnique({ where: { slug: 'dynamicsops' } })) ??
        (await this.prisma.workspaces.findFirst({ orderBy: { created_at: 'asc' } }));
      if (def) await this.prisma.memberships.create({ data: { workspace_id: def.id, user_id: user.id, role: user.role } });
    }

    const token = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { secret: process.env.JWT_SECRET ?? 'dev-only-change-me', expiresIn: '12h' },
    );
    return { accessToken: token, user: this.publicUser(user) };
  }

  publicUser(u: { id: string; email: string; display_name: string; role: string; approval_limit: any }) {
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      role: u.role,
      approvalLimit: u.approval_limit ? Number(u.approval_limit) : null,
    };
  }
}
