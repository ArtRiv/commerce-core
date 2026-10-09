import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { PinoLoggerService } from './pino-logger.service';

describe('HttpLoggingInterceptor', () => {
  let interceptor: HttpLoggingInterceptor;
  let loggerMock: {
    setContext: jest.Mock;
    log: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
  };

  beforeEach(() => {
    loggerMock = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    interceptor = new HttpLoggingInterceptor(
      loggerMock as unknown as PinoLoggerService,
    );
  });

  const createMockContext = (
    url: string,
    method: string,
    statusCode: number,
  ): ExecutionContext => {
    const req = { url, originalUrl: url, method };
    const res = { statusCode };

    return {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  };

  it('deve registrar requisição bem-sucedida (200) com INFO (log) e latência em ms', (done) => {
    const context = createMockContext('/catalog/products', 'GET', 200);
    const handler: CallHandler = { handle: () => of({ success: true }) };

    interceptor.intercept(context, handler).subscribe({
      next: () => {
        expect(loggerMock.log).toHaveBeenCalledTimes(1);
        const [payload, msg] = loggerMock.log.mock.calls[0];
        expect(payload.method).toBe('GET');
        expect(payload.url).toBe('/catalog/products');
        expect(payload.status_code).toBe(200);
        expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
        expect(msg).toBe('HTTP Request Completed');
        done();
      },
    });
  });

  it('deve registrar requisição de erro do cliente (404) com WARN', (done) => {
    const context = createMockContext('/orders/unknown-id', 'GET', 404);
    const handler: CallHandler = { handle: () => of(null) };

    interceptor.intercept(context, handler).subscribe({
      next: () => {
        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        const [payload] = loggerMock.warn.mock.calls[0];
        expect(payload.status_code).toBe(404);
        done();
      },
    });
  });

  it('deve registrar requisições de probe (/health) com DEBUG para não poluir logs', (done) => {
    const context = createMockContext('/health', 'GET', 200);
    const handler: CallHandler = { handle: () => of({ status: 'ok' }) };

    interceptor.intercept(context, handler).subscribe({
      next: () => {
        expect(loggerMock.debug).toHaveBeenCalledTimes(1);
        done();
      },
    });
  });

  it('deve interceptar exceção 500 não tratada e registrar com ERROR antes de repassar', (done) => {
    const context = createMockContext('/checkout', 'POST', 200);
    const error = new Error('Database connection failed');
    const handler: CallHandler = {
      handle: () => throwError(() => error),
    };

    interceptor.intercept(context, handler).subscribe({
      error: (err) => {
        expect(err).toBe(error);
        expect(loggerMock.error).toHaveBeenCalledTimes(1);
        const [payload] = loggerMock.error.mock.calls[0];
        expect(payload.status_code).toBe(500);
        expect(payload.err.message).toBe('Database connection failed');
        done();
      },
    });
  });

  it('deve registrar HttpException do cliente (ex: 400 Bad Request) com WARN', (done) => {
    const context = createMockContext('/auth/login', 'POST', 200);
    const httpException = new HttpException(
      'Invalid credentials',
      HttpStatus.BAD_REQUEST,
    );
    const handler: CallHandler = {
      handle: () => throwError(() => httpException),
    };

    interceptor.intercept(context, handler).subscribe({
      error: (err) => {
        expect(err).toBe(httpException);
        expect(loggerMock.warn).toHaveBeenCalledTimes(1);
        const [payload] = loggerMock.warn.mock.calls[0];
        expect(payload.status_code).toBe(400);
        done();
      },
    });
  });
});
