import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { ApprovalsService } from '../approvals/approvals.service';
import { ApprovalsModule } from '../approvals/approvals.module';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

// Calendar actions surfaced on the dedicated Meetings page.
const MEETING_ACTIONS = ['create_calendar_event', 'update_calendar_event'];

// Pull the meeting details out of a calendar tool_call's args (field names vary
// by what the agent emitted).
function buildMeeting(args: any, activity: any) {
  const a = args ?? {};
  return {
    start: a.start ?? a.startTime ?? null,
    end: a.end ?? a.endTime ?? null,
    attendees: a.attendees ?? a.to ?? [],
    location: a.location ?? null,
    title: a.subject ?? a.title ?? activity?.subject ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MeetingsController — calendar approvals, separate from the Approval Center.
// ─────────────────────────────────────────────────────────────────────────────
@Controller('meetings')
class MeetingsController {
  constructor(private readonly approvals: ApprovalsService) {}

  // ── GET /meetings ─────────────────────────────────────────────────────────
  // Pending approvals whose action is a calendar action, enriched with a
  // `meeting` object. Reuses ApprovalsService.list (tenant-scoped) + post-filter.
  @Get()
  async list() {
    const all = await this.approvals.list({ status: 'pending' });
    return all
      .filter((a: any) => MEETING_ACTIONS.includes(a.action))
      .map((a: any) => ({ ...a, meeting: buildMeeting(a.tool_call?.args, a.activity) }));
  }

  // ── POST /meetings/:id/accept ─────────────────────────────────────────────
  @Roles('consultant')
  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.approvals.approve(id, user, { note: 'meeting accepted' });
  }

  // ── POST /meetings/:id/reject ─────────────────────────────────────────────
  @Roles('consultant')
  @Post(':id/reject')
  reject(@Param('id') id: string, @Body() body: { note?: string }, @CurrentUser() user: AuthUser) {
    return this.approvals.reject(id, user, body?.note ?? 'meeting declined');
  }

  // ── POST /meetings/:id/propose-time ───────────────────────────────────────
  @Roles('consultant')
  @Post(':id/propose-time')
  proposeTime(
    @Param('id') id: string,
    @Body() body: { newTime: string; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.approvals.proposeMeetingTime(id, user, body?.newTime ?? '', body?.note);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────
@Module({
  imports: [ApprovalsModule],
  controllers: [MeetingsController],
})
export class MeetingsModule {}
