import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { TenantMiddleware } from './common/tenant.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { AuditModule } from './common/audit.service';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt.guard';
import { InboxModule } from './modules/inbox/inbox.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { WorkflowsModule } from './modules/workflows/workflows.controller';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditReadModule } from './modules/audit/audit.controller';
import { DashboardModule } from './modules/dashboard/dashboard.controller';
import { KnowledgeModule } from './modules/knowledge/knowledge.controller';
import { IntegrationsModule } from './integrations/integrations.controller';
import { IngestionModule } from './integrations/ingestion.poller';
import { EmailWatchModule } from './integrations/email-watch.service';
import { AdoIngestionModule } from './integrations/ado-ingestion.service';
import { WorkspacesModule } from './modules/workspaces/workspaces.controller';
import { BacktestModule } from './modules/backtest/backtest.controller';
import { NotificationsModule } from './modules/notifications/notifications.controller';
import { TemplatesModule } from './modules/templates/templates.controller';
import { ProposalMiningModule } from './modules/proposal-mining/proposal-mining.controller';
import { StreamModule } from './modules/stream/stream.controller';
import { AutomationsModule } from './modules/automations/automations.controller';
import { MissionsModule } from './modules/missions/missions.controller';
import { PerformanceModule } from './modules/performance/performance.controller';
import { AnalystModule } from './modules/analyst/analyst.controller';
import { SkillsModule } from './modules/skills/skills.controller';
import { TeamsModule } from './modules/teams/teams.controller';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.controller';
import { ReportsModule } from './modules/reports/reports.controller';
import { StatusReportsModule } from './modules/status-reports/status-reports.controller';
import { StyleModule } from './modules/style/style.controller';
import { CodeTasksModule } from './modules/code-tasks/code-tasks.controller';
import { ReplySettingsModule } from './modules/reply-settings/reply-settings.controller';
import { MeetingsModule } from './modules/meetings/meetings.controller';
import { DevicesModule } from './modules/devices/devices.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    QueueModule,
    AuditModule,
    AuthModule,
    InboxModule,
    DirectoryModule,
    WorkflowsModule,
    ApprovalsModule,
    AuditReadModule,
    DashboardModule,
    KnowledgeModule,
    IntegrationsModule,
    IngestionModule,
    EmailWatchModule,
    AdoIngestionModule,
    WorkspacesModule,
    BacktestModule,
    NotificationsModule,
    TemplatesModule,
    ProposalMiningModule,
    StreamModule,
    AutomationsModule,
    MissionsModule,
    PerformanceModule,
    AnalystModule,
    SkillsModule,
    TeamsModule,
    WhatsAppModule,
    ReportsModule,
    StatusReportsModule,
    StyleModule,
    CodeTasksModule,
    ReplySettingsModule,
    MeetingsModule,
    DevicesModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
