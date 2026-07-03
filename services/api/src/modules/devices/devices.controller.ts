import { Body, Controller, Delete, Module, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../auth/decorators';
import { tenantStore } from '../../common/tenant';

// Mobile device registry for FCM push. Any authenticated user may register
// their own device; unregister is by exact token (called on logout).
@Controller('devices')
class DevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('register')
  async register(
    @Body() body: { platform: 'ios' | 'android'; token: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body?.token || !body?.platform) return { ok: false, detail: 'platform and token required' };
    const wsId = tenantStore.getStore()?.workspaceId ?? null;
    const row = await (this.prisma as any).device_tokens.upsert({
      where: { token: body.token },
      update: { user_id: user.id, workspace_id: wsId, platform: body.platform, last_seen_at: new Date() },
      create: { token: body.token, platform: body.platform, user_id: user.id, workspace_id: wsId },
    });
    return { ok: true, id: row.id };
  }

  @Delete(':token')
  async unregister(@Param('token') token: string) {
    await (this.prisma as any).device_tokens.deleteMany({ where: { token } });
    return { ok: true };
  }
}

@Module({ controllers: [DevicesController] })
export class DevicesModule {}
