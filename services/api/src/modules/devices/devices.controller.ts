import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../auth/decorators';
import { tenantStore } from '../../common/tenant';
import { AuditService } from '../../common/audit.service';

// Mobile device registry for FCM push. Any authenticated user may register
// their own device; unregister is by exact token (called on logout).
@Controller('devices')
export class DevicesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post('register')
  async register(
    @Body() body: { platform: 'ios' | 'android'; token: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body?.token || (body.platform !== 'ios' && body.platform !== 'android')) {
      return { ok: false, detail: 'platform must be ios|android and token required' };
    }
    const wsId = tenantStore.getStore()?.workspaceId ?? null;
    const row = await (this.prisma as any).device_tokens.upsert({
      where: { token: body.token },
      update: { user_id: user.id, workspace_id: wsId, platform: body.platform, last_seen_at: new Date() },
      create: { token: body.token, platform: body.platform, user_id: user.id, workspace_id: wsId },
    });
    return { ok: true, id: row.id };
  }

  @Delete(':token')
  async unregister(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    // Scoped to the caller — a user may only unregister their own device.
    await (this.prisma as any).device_tokens.deleteMany({ where: { token, user_id: user.id } });
    return { ok: true };
  }

  @Get('commands')
  async listCommands(@Query('status') status: string | undefined, @CurrentUser() user: AuthUser) {
    const wsId = tenantStore.getStore()?.workspaceId ?? null;
    const where: any = { user_id: user.id };
    if (wsId) where.workspace_id = wsId;
    if (status) where.status = status;
    const rows = await (this.prisma as any).device_commands.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    const now = new Date();
    const fresh = [];
    for (const row of rows) {
      if (row.status === 'approved' && row.expires_at && row.expires_at < now) {
        await (this.prisma as any).device_commands.update({
          where: { id: row.id },
          data: { status: 'expired' },
        });
        row.status = 'expired';
      }
      if (!status || row.status === status) fresh.push(row);
    }
    return { commands: fresh };
  }

  @Post('commands/:id/result')
  async postResult(
    @Param('id') id: string,
    @Body() body: { status: 'succeeded' | 'failed'; steps: any[]; detail?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const wsId = tenantStore.getStore()?.workspaceId ?? null;
    const cmd = await (this.prisma as any).device_commands.findUnique({ where: { id } });
    if (!cmd || cmd.user_id !== user.id || (wsId && cmd.workspace_id !== wsId)) {
      return { ok: false, detail: 'not found' };
    }
    if (cmd.status === 'approved' && cmd.expires_at && cmd.expires_at < new Date()) {
      await (this.prisma as any).device_commands.update({ where: { id }, data: { status: 'expired' } });
      return { ok: false, detail: 'command expired' };
    }

    const allStepsOk = Array.isArray(body.steps) && body.steps.every((s) => s?.ok === true);
    const finalStatus = body.status === 'succeeded' && allStepsOk ? 'succeeded' : 'failed';
    await (this.prisma as any).device_commands.update({
      where: { id },
      data: {
        status: finalStatus,
        result: { ok: finalStatus === 'succeeded', steps: body.steps, detail: body.detail } as any,
      },
    });
    await this.audit.log({
      actorType: 'user',
      actorUserId: user.id,
      action: 'update',
      entityType: 'device_commands',
      entityId: id,
      summary: `Phone task ${cmd.kind}: ${finalStatus}`,
    });
    return { ok: true };
  }
}
