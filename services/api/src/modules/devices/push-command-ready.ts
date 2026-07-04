import { PrismaService } from '../../prisma/prisma.service';
import { sendFcmSilent } from '../../integrations/push/fcm';

export async function pushCommandReady(
  prisma: PrismaService,
  userId: string,
  commandId: string,
  workspaceId?: string | null,
) {
  const where: any = { user_id: userId };
  if (workspaceId) where.workspace_id = workspaceId;
  const tokens = await (prisma as any).device_tokens.findMany({ where });
  for (const t of tokens) {
    const result = await sendFcmSilent(t.token, { type: 'command', id: commandId });
    if (result === 'unregistered') {
      await (prisma as any).device_tokens.deleteMany({ where: { token: t.token } });
    }
  }
}
