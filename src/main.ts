import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { setupSwagger } from './openapi/document';
import { resolveTrustProxyHops } from './trust-proxy';

async function bootstrap() {
  // rawBody keeps the untouched request bytes alongside the parsed body. The
  // payment webhook needs them: its signature is an HMAC over exactly what was
  // sent, and re-serialising the parsed JSON does not reproduce those bytes.
  // Without this the route cannot verify anything (docs/specs/payments.md).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // How far to walk back through X-Forwarded-For to find the caller. This is
  // what every rate limit is keyed on, so getting it wrong silently disables
  // them — see trust-proxy.ts for both failure modes. Resolved here rather
  // than in a module because it configures the HTTP adapter, not the graph;
  // it still throws before anything binds a port (docs/specs/deploy.md).
  app.set('trust proxy', resolveTrustProxyHops(app.get(ConfigService)));

  // Served in every environment, production included. This is a headless API
  // whose documentation being browsable is part of the point, and nothing is
  // less protected for being described — the guards do not consult the
  // document (docs/specs/openapi.md).
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err: unknown) => {
  console.error('Failed to start application', err);
  process.exit(1);
});
