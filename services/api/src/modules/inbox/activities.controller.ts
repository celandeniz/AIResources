import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ActivitiesService } from './activities.service';
import { Roles, CurrentUser, AuthUser, Public } from '../../auth/decorators';
import { ACTIVITY_CHANNELS, PRIORITIES } from '@dynops/shared';

class CreateActivityDto {
  @IsString() subject!: string;
  @IsOptional() @IsString() body?: string;
  @IsOptional() @IsIn(ACTIVITY_CHANNELS as unknown as string[]) channel?: any;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsIn(PRIORITIES as unknown as string[]) priority?: any;
  @IsOptional() @IsString() category?: string;
}

class AssignDto {
  @IsUUID() aiResourceId!: string;
}

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly svc: ActivitiesService) {}

  @Get()
  list(@Query() q: any) {
    return this.svc.list({
      status: q.status,
      channel: q.channel,
      customerId: q.customerId,
      projectId: q.projectId,
      assignedResourceId: q.assignedResourceId,
      priority: q.priority,
      q: q.q,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Roles('consultant')
  @Post()
  create(@Body() dto: CreateActivityDto, @CurrentUser() user: AuthUser) {
    return this.svc.createManual(dto, user.id);
  }

  @Roles('consultant')
  @Post('trigger-mock-email')
  triggerMockEmail() {
    return this.svc.triggerMockEmail();
  }

  // Ingestion webhook (mock connectors / service token).
  @Public()
  @Post('ingest')
  ingest(@Body() body: any) {
    return this.svc.ingest(body);
  }

  @Roles('manager')
  @Post(':id/assign')
  assign(@Param('id') id: string, @Body() dto: AssignDto, @CurrentUser() user: AuthUser) {
    return this.svc.assign(id, dto.aiResourceId, user.id);
  }

  @Roles('manager')
  @Post(':id/reprocess')
  reprocess(@Param('id') id: string) {
    return this.svc.reprocess(id);
  }

  @Roles('manager')
  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: any) {
    return this.svc.patch(id, body);
  }
}
