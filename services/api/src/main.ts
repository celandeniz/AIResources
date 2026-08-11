import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true exposes req.rawBody (the exact received bytes) so webhook HMAC
  // signature checks (e.g. WhatsApp x-hub-signature-256) verify the real payload.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true, rawBody: true });
  // Training Markdown may contain up to six embedded screenshots. Parse only
  // its scoped edit route with a larger ceiling before Nest's default parser;
  // webhook routes keep the default raw-body-aware parser and body limit.
  app.useBodyParser('json', {
    limit: process.env.DOC_EDIT_BODY_LIMIT ?? '50mb',
    type: (req: any) => req.method === 'PATCH' &&
      /^\/api\/v1\/projects\/[^/]+\/documents\/[^/?]+(?:\?|$)/.test(String(req.originalUrl ?? req.url ?? '')) &&
      /^application\/(?:[\w.+-]+\+)?json\b/i.test(String(req.headers?.['content-type'] ?? '')),
  });
  // Register the ordinary parser explicitly as well: the Express adapter sees
  // the route parser's `jsonParser` name and otherwise skips its own default.
  app.useBodyParser('json', { limit: '100kb' });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on :${port} (AUTH_MODE=${process.env.AUTH_MODE ?? 'dev'})`, 'Bootstrap');
}
bootstrap();
