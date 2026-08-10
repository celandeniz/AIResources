// Internal CI-status endpoint for the worker's dev-pod CI poll loop.
// Reached with x-internal-token (JwtAuthGuard's internal path grants admin).

import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../auth/decorators';
import { getBranch, getCompareStats, getLatestWorkflowRun, getWorkflowRunFailureExcerpt, githubConfigured } from './github.adapter';

@Controller('internal/github')
export class GitHubInternalController {
  @Roles('admin')
  @Get('ci-status')
  async ciStatus(@Query('repo') repo: string, @Query('branch') branch: string, @Query('workflow') workflow?: string) {
    if (!githubConfigured()) return { configured: false };
    const [branchInfo, run] = await Promise.all([
      getBranch(repo, branch),
      getLatestWorkflowRun(repo, branch, workflow || undefined),
    ]);
    let failureExcerpt = '';
    if (run && run.conclusion === 'failure') {
      failureExcerpt = await getWorkflowRunFailureExcerpt(repo, run.id);
    }
    return { configured: true, branch: branchInfo, run, failureExcerpt };
  }

  @Roles('admin')
  @Get('compare')
  async compare(@Query('repo') repo: string, @Query('base') base: string, @Query('head') head: string) {
    if (!githubConfigured()) return { configured: false };
    const stats = await getCompareStats(repo, base, head);
    return stats ? { configured: true, ...stats } : { configured: true, files: null, paths: [] };
  }
}
