import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list({ status: q.status, aiResourceId: q.aiResourceId, riskLevel: q.riskLevel });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  // Bulk decision for multi-select in the Approval Center. Processed sequentially
  // (each approve executes its tool_call) so failures are isolated per item.
  // Declared before :id routes so "bulk" is never treated as an :id.
  @Roles('consultant')
  @Post('bulk')
  async bulk(@Body() body: { ids: string[]; action: 'approve' | 'reject'; note?: string }, @CurrentUser() user: AuthUser) {
    const ids = Array.isArray(body?.ids) ? body.ids.filter(Boolean) : [];
    const action = body?.action === 'reject' ? 'reject' : 'approve';
    const note = body?.note ?? `bulk ${action} via UI`;
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        if (action === 'approve') await this.svc.approve(id, user, { note });
        else await this.svc.reject(id, user, note);
        succeeded.push(id);
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    return { action, requested: ids.length, succeeded: succeeded.length, failed };
  }

  @Roles('consultant')
  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: { note?: string; editedPayload?: any }, @CurrentUser() user: AuthUser) {
    return this.svc.approve(id, user, body ?? {});
  }

  @Roles('consultant')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: { note: string }, @CurrentUser() user: AuthUser) {
    return this.svc.reject(id, user, body?.note ?? '');
  }
}
