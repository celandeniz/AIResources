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
