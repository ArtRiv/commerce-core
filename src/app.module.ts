import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { IntegrationsModule } from './integrations/integrations.module';
import { MailModule } from './mail/mail.module';
import { MessagingModule } from './messaging/messaging.module';
import { ObservabilityModule } from './observability/observability.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ObservabilityModule,
    MessagingModule,
    // Baseline global de rate limiting. Cada rota sensível sobrescreve com seu
    // próprio @Throttle. Storage em memória — suficiente para um processo;
    // trocar por Redis é uma mudança aqui e em nenhum outro lugar.
    // Usa ClientIpThrottlerGuard em vez de ThrottlerGuard porque req.ip é
    // instável atrás de um edge com forwarded chain variável (ver client-ip.ts).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    PrismaModule,
    MailModule,
    AuthModule,
    CatalogModule,
    OrdersModule,
    ReportsModule,
    IntegrationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      // Registrado no grafo de módulos (não em main.ts) para que os testes
      // de integração validem exatamente como produção — um pipe em main.ts
      // some silenciosamente nos testes.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // Strip unknown properties, and reject rather than ignore them: a body
        // carrying `roleId` should fail loudly, not have it quietly dropped.
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
