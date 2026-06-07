import { Body, Controller, Get, Module, Param, Put } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';
import { currentWorkspaceId } from '../../common/tenant';

// Account types that can receive replies (and therefore get a Kurulum row).
const REPLY_TYPES = ['graph_email', 'graph_teams', 'whatsapp'];

// Sensible defaults applied to any account that has no saved reply_settings row.
const DEFAULTS = {
  auto_reply_enabled: true,
  reply_as_name: null as string | null,
  reply_as_email: null as string | null,
  signature: null as string | null,
  resource_key: null as string | null,
};

// ─────────────────────────────────────────────────────────────────────────────
// ReplySettingsController
// ─────────────────────────────────────────────────────────────────────────────
@Controller('reply-settings')
class ReplySettingsController {
  constructor(private readonly prisma: PrismaService) {}

  // ── GET /reply-settings ──────────────────────────────────────────────────
  // One entry per connected account PLUS a global default (prepended).
  @Get()
  async list() {
    const wsId = currentWorkspaceId();

    const integrations = await this.prisma.integrations.findMany({
      where: { type: { in: REPLY_TYPES as any } },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });

    const saved = await (this.prisma as any).reply_settings.findMany({
      where: wsId ? { workspace_id: wsId } : {},
    });
    const byIntegration = new Map<string | null, any>();
    for (const row of saved) byIntegration.set(row.integration_id ?? null, row);

    const fromRow = (row: any) => ({
      auto_reply_enabled: row?.auto_reply_enabled ?? DEFAULTS.auto_reply_enabled,
      reply_as_name: row?.reply_as_name ?? DEFAULTS.reply_as_name,
      reply_as_email: row?.reply_as_email ?? DEFAULTS.reply_as_email,
      signature: row?.signature ?? DEFAULTS.signature,
      resource_key: row?.resource_key ?? DEFAULTS.resource_key,
    });

    const globalRow = byIntegration.get(null) ?? null;
    const global = {
      integration_id: null,
      account_label: 'Global (varsayılan)',
      channel: 'global',
      mailbox: null,
      is_mock: false,
      ...fromRow(globalRow),
    };

    const accounts = integrations.map((i) => {
      const row = byIntegration.get(i.id) ?? null;
      return {
        integration_id: i.id,
        account_label: i.name,
        channel: i.type,
        mailbox: (i.config as any)?.mailbox ?? null,
        is_mock: i.is_mock,
        ...fromRow(row),
      };
    });

    return [global, ...accounts];
  }

  // ── GET /reply-settings/resources ────────────────────────────────────────
  // AI resources for the "who drafts the reply" persona dropdown.
  @Get('resources')
  resources() {
    return this.prisma.ai_resources.findMany({
      where: { status: 'active' },
      select: { key: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── PUT /reply-settings/:scope ───────────────────────────────────────────
  // scope = an integration_id (uuid) or the literal "global". Upsert the row.
  @Roles('manager')
  @Put(':scope')
  async upsert(
    @Param('scope') scope: string,
    @Body() body: {
      account_label?: string;
      auto_reply_enabled?: boolean;
      reply_as_name?: string | null;
      reply_as_email?: string | null;
      signature?: string | null;
      resource_key?: string | null;
    },
    @CurrentUser() user: AuthUser,
  ) {
    const wsId = currentWorkspaceId();
    const integrationId = scope === 'global' ? null : scope;

    const existing = await (this.prisma as any).reply_settings.findFirst({
      where: { workspace_id: wsId ?? undefined, integration_id: integrationId },
    });

    const data: any = {};
    if (body.account_label !== undefined) data.account_label = body.account_label;
    if (body.auto_reply_enabled !== undefined) data.auto_reply_enabled = body.auto_reply_enabled;
    if (body.reply_as_name !== undefined) data.reply_as_name = body.reply_as_name;
    if (body.reply_as_email !== undefined) data.reply_as_email = body.reply_as_email;
    if (body.signature !== undefined) data.signature = body.signature;
    if (body.resource_key !== undefined) data.resource_key = body.resource_key || null;

    if (existing) {
      return (this.prisma as any).reply_settings.update({
        where: { id: existing.id },
        data,
      });
    }

    return (this.prisma as any).reply_settings.create({
      data: {
        workspace_id: wsId ?? undefined,
        integration_id: integrationId,
        account_label: body.account_label ?? (integrationId ? 'Account' : 'Global (varsayılan)'),
        auto_reply_enabled: body.auto_reply_enabled ?? DEFAULTS.auto_reply_enabled,
        reply_as_name: body.reply_as_name ?? null,
        reply_as_email: body.reply_as_email ?? null,
        signature: body.signature ?? null,
        resource_key: body.resource_key || null,
        created_by: user.id ?? null,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module
// ─────────────────────────────────────────────────────────────────────────────
@Module({
  controllers: [ReplySettingsController],
})
export class ReplySettingsModule {}
