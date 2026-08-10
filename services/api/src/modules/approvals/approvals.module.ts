import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ToolCallsController } from './tool-calls.controller';
import { IntegrationsModule } from '../../integrations/integrations.controller';
import { InstinctsModule } from '../instincts/instincts.module';

@Module({
  imports: [IntegrationsModule, InstinctsModule],
  controllers: [ApprovalsController, ToolCallsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
