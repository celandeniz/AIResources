import { Controller, Get, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { currentWorkspaceId } from '../../common/tenant';
import { streamEvents, type StreamEvent } from '../../common/events';

@Controller('stream')
class StreamController {
  @Get()
  stream(@Res() res: Response) {
    const workspaceId = currentWorkspaceId();
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: StreamEvent) => {
      if (event.workspaceId && workspaceId && event.workspaceId !== workspaceId) return;
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    streamEvents.on('event', send);
    res.on('close', () => {
      clearInterval(heartbeat);
      streamEvents.off('event', send);
      res.end();
    });
  }
}

@Module({ controllers: [StreamController] })
export class StreamModule {}
