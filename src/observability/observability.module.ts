import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { PinoLoggerService } from './pino-logger.service';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

/**
 * Módulo Global de Observabilidade com Pino e AsyncLocalStorage.
 *
 * Fornece:
 * 1. RequestContextService: rastreamento assíncrono de tenant_id, order_id e correlation_id.
 * 2. PinoLoggerService: logger estruturado em formato JSON de alta performance com redação de dados sensíveis.
 * 3. RequestContextMiddleware: interceptação inicial de headers HTTP e amarração do contexto assíncrono.
 * 4. HttpLoggingInterceptor: log automático de tráfego HTTP com cálculo de latência e classificação de status.
 */
@Global()
@Module({
  providers: [
    RequestContextService,
    PinoLoggerService,
    HttpLoggingInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpLoggingInterceptor,
    },
  ],
  exports: [RequestContextService, PinoLoggerService, HttpLoggingInterceptor],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
