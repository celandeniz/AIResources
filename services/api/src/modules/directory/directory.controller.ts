import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { DirectoryService } from './directory.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

@Controller('ai-resources')
export class DirectoryController {
  constructor(private readonly svc: DirectoryService) {}

  @Get()
  list(@Query('active') active?: string) {
    return this.svc.list(active === 'true');
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Get(':id/metrics')
  metrics(@Param('id') id: string) {
    return this.svc.metrics(id);
  }

  @Get(':id/prompt-versions')
  promptVersions(@Param('id') id: string) {
    return this.svc.promptVersions(id);
  }

  @Roles('admin')
  @Post(':id/prompt-versions')
  createPromptVersion(@Param('id') id: string, @Body() body: { system_prompt: string }, @CurrentUser() user: AuthUser) {
    return this.svc.createPromptVersion(id, body.system_prompt, user.id);
  }

  @Roles('admin')
  @Post(':id/prompt-versions/:version/rollback')
  rollbackPrompt(@Param('id') id: string, @Param('version') version: string, @CurrentUser() user: AuthUser) {
    return this.svc.rollbackPrompt(id, Number(version), user.id);
  }

  @Roles('admin')
  @Post()
  create(@Body() body: any) {
    return this.svc.create(body);
  }

  @Roles('admin')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    return this.svc.update(id, body, user.id);
  }

  @Roles('manager')
  @Post(':id/toggle-active')
  toggle(@Param('id') id: string, @Body('active') active: boolean) {
    return this.svc.toggleActive(id, active);
  }
}
