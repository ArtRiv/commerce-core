import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { setupSwagger } from './openapi/document';

async function bootstrap() {
  // rawBody keeps the untouched request bytes alongside the parsed body. The
  // payment webhook needs them: its signature is an HMAC over exactly what was
  // sent, and re-serialising the parsed JSON does not reproduce those bytes.
  // Without this the route cannot verify anything (docs/specs/payments.md).
  const app = await NestFactory.create(AppModule, { rawBody: true });

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
