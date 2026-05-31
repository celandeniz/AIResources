import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../auth/decorators';
import { AuditModule } from '../../common/audit.service';
import { emitStreamEvent } from '../../common/events';

@Controller('notifications')
class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('unread') unread?: string) {
    const where = unread === 'true' ? { read: false } : {};
    return (this.prisma as any).notifications.findMany({ where, orderBy: { created_at: 'desc' }, take: 100 });
  }

  @Roles('consultant')
  @Post(':id/read')
  async markRead(@Param('id') id: string, @Body('read') read?: boolean) {
    const row = await (this.prisma as any).notifications.update({ where: { id }, data: { read: read ?? true } });
    emitStreamEvent({ type: 'notification', workspaceId: row.workspace_id, payload: row });
    return row;
  }

  @Roles('consultant')
  @Post('mark-read')
  async markAllRead() {
    await (this.prisma as any).notifications.updateMany({ where: { read: false }, data: { read: true } });
    return { ok: true };
  }
}

@Module({ imports: [AuditModule], controllers: [NotificationsController] })
export class NotificationsModule {}
