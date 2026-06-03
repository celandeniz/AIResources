import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list({
      status: q.status,
      riskLevel: q.riskLevel,
      aiResourceId: q.aiResourceId,
      model: q.model,
      subject: q.subject,
      aiAnswersOnly: q.aiAnswersOnly === 'true' || q.aiAnswersOnly === true,
      hideSystem: q.hideSystem !== 'false', // default: hide system-generated
    });
  }

  // Distinct AI resources + models among approvals — populates the filter dropdowns.
  // Declared before :id so "filter-options" is never treated as an :id.
  @Get('filter-options')
  filterOptions() {
    return this.svc.filterOptions();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  // Save an edited AI answer (no execution yet).
  @Roles('consultant')
  @Post(':id/draft')
  saveDraft(@Param('id') id: string, @Body() body: { content: string; subject?: string }, @CurrentUser() user: AuthUser) {
    return this.svc.saveDraft(id, user, body ?? { content: '' });
  }

  // Regenerate the AI answer from the original context + a short instruction.
  @Roles('consultant')
  @Post(':id/regenerate')
  regenerate(@Param('id') id: string, @Body() body: { instruction: string }, @CurrentUser() user: AuthUser) {
    return this.svc.regenerate(id, user, body?.instruction ?? '');
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
