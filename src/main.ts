import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { PinoLoggerService } from './observability/pino-logger.service';
import { setupSwagger } from './openapi/document';
import { resolveTrustProxyHops } from './trust-proxy';

async function bootstrap() {
  // rawBody preserva os bytes brutos da requisição para validação de assinatura HMAC em webhooks.
  // bufferLogs retém os logs iniciais até o PinoLoggerService ser acoplado.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  const logger = app.get(PinoLoggerService);
  app.useLogger(logger);

  // Configura a contagem de saltos de proxy para identificar o IP real do cliente nos limitadores de taxa.
  app.set('trust proxy', resolveTrustProxyHops(app.get(ConfigService)));

  // Documentação Swagger/OpenAPI habilitada para navegação e consumo da API headless.
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err: unknown) => {
  console.error('Failed to start application', err);
  process.exit(1);
});
