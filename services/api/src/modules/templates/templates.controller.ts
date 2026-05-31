import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles, CurrentUser, AuthUser } from '../../auth/decorators';

@Controller('templates')
class TemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query('type') type?: string) {
    return (this.prisma as any).templates.findMany({
      where: type ? { type } : {},
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  @Roles('consultant')
  @Post()
  create(@Body() body: { name: string; type: string; content: string; metadata?: any }, @CurrentUser() user: AuthUser) {
    return (this.prisma as any).templates.create({
      data: { name: body.name, type: body.type, content: body.content, metadata: body.metadata ?? {}, created_by: user.id },
    });
  }

  @Roles('consultant')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; type?: string; content?: string; metadata?: any }) {
    return (this.prisma as any).templates.update({ where: { id }, data: body });
  }

  @Roles('manager')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    await (this.prisma as any).templates.delete({ where: { id } });
    return { ok: true };
  }
}

@Module({ controllers: [TemplatesController] })
export class TemplatesModule {}
