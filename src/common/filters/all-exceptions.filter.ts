import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Filtro global de exceções.
 *
 * Captura qualquer exceção não tratada — incluindo erros de programação
 * (`new Error()`) que o handler padrão do NestJS exporia como um 500
 * genérico sem contexto de log. Garante que toda falha seja:
 *   1. Registrada com método, URL e stack trace (sem vazar detalhes ao cliente).
 *   2. Respondida com o shape padrão `{ statusCode, message, timestamp }`.
 *
 * Registrado via `APP_FILTER` em `AppModule` para que o filtro participe do
 * grafo de injeção e seja testável junto com o restante da aplicação.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!isHttp) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const responseBody = isHttp ? exception.getResponse() : null;

    let message: string | string[] = 'Erro interno do servidor.';
    if (isHttp) {
      if (typeof responseBody === 'string') {
        message = responseBody;
      } else if (
        typeof responseBody === 'object' &&
        responseBody !== null &&
        'message' in responseBody
      ) {
        message = (responseBody as { message: string | string[] }).message;
      } else {
        message = exception.message;
      }
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
