import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import { PinoLoggerService } from './pino-logger.service';

/**
 * Interceptor global de observabilidade para requisições HTTP.
 *
 * Registra o tempo de resposta (latência em ms), método, rota e código de status.
 * Automaticamente classifica a severidade do log:
 *   - 5xx: ERROR
 *   - 4xx: WARN
 *   - 2xx / 3xx: INFO
 *
 * Rotas de health check (/health) são tratadas em nível DEBUG para evitar ruído.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLoggerService) {
    this.logger.setContext('HTTP');
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const startTime = Date.now();
    const isProbe = req.url === '/health' || req.url === '/favicon.ico';

    return next.handle().pipe(
      tap(() => {
        const durationMs = Date.now() - startTime;
        const statusCode = res.statusCode || 200;

        const logPayload = {
          method: req.method,
          url: req.originalUrl || req.url,
          status_code: statusCode,
          duration_ms: durationMs,
        };

        if (isProbe) {
          this.logger.debug(logPayload, 'HTTP Probe Request Completed');
        } else if (statusCode >= 500) {
          this.logger.error(logPayload, 'HTTP Request Failed');
        } else if (statusCode >= 400) {
          this.logger.warn(logPayload, 'HTTP Request Completed with Warning');
        } else {
          this.logger.log(logPayload, 'HTTP Request Completed');
        }
      }),
      catchError((error: unknown) => {
        const durationMs = Date.now() - startTime;
        const statusCode =
          error instanceof HttpException ? error.getStatus() : 500;

        const logPayload = {
          method: req.method,
          url: req.originalUrl || req.url,
          status_code: statusCode,
          duration_ms: durationMs,
          err:
            error instanceof Error
              ? { message: error.message, stack: error.stack }
              : String(error),
        };

        if (statusCode >= 500) {
          this.logger.error(logPayload, 'HTTP Request Failed with Exception');
        } else {
          this.logger.warn(
            logPayload,
            'HTTP Request Failed with Client Exception',
          );
        }

        return throwError(() => error);
      }),
    );
  }
}
