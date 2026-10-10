import { Writable } from 'node:stream';

import { Controller, Get, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { ObservabilityModule } from './observability.module';
import { PinoLoggerService } from './pino-logger.service';
import { RequestContextService } from './request-context.service';

@Controller('test-observability')
class TestObservabilityController {
  private readonly logger = new Logger(TestObservabilityController.name);

  constructor(private readonly contextService: RequestContextService) {}

  @Get('order-flow')
  getOrderFlow() {
    this.logger.log('Início da requisição antes do order_id');

    // Simula a criação ou resolução dinâmica de um pedido
    this.contextService.setOrderId('ord-real-999');

    this.logger.log('Após associar order_id ao fluxo assíncrono');
    return { status: 'success', orderId: 'ord-real-999' };
  }
}

describe('Observability Integration (Pino + AsyncLocalStorage)', () => {
  let app: any;
  let logLines: string[];
  let logStream: Writable;
  let pinoLoggerService: PinoLoggerService;

  beforeAll(async () => {
    logLines = [];
    logStream = new Writable({
      write(chunk, encoding, callback) {
        logLines.push(chunk.toString());
        callback();
      },
    });

    pinoLoggerService = new PinoLoggerService({
      level: 'trace',
      stream: logStream,
      pretty: false,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ObservabilityModule],
      controllers: [TestObservabilityController],
    })
      .overrideProvider(PinoLoggerService)
      .useValue(pinoLoggerService)
      .compile();

    app = moduleRef.createNestApplication();
    app.useLogger(pinoLoggerService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  it('deve injetar correlation_id e tenant_id via headers e propagar order_id dinâmico nos logs estruturados', async () => {
    const response = await request(app.getHttpServer())
      .get('/test-observability/order-flow')
      .set('X-Correlation-Id', 'trace-custom-555')
      .set('X-Tenant-Id', 'tenant-avesso-brazil')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('trace-custom-555');
    expect(response.headers['x-tenant-id']).toBe('tenant-avesso-brazil');

    const parsedLogs = logLines.map((line) => JSON.parse(line));

    // Todos os logs emitidos durante a requisição devem ter correlation_id e tenant_id
    for (const log of parsedLogs) {
      expect(log.correlation_id).toBe('trace-custom-555');
      expect(log.tenant_id).toBe('tenant-avesso-brazil');
    }

    // O primeiro log do controller não possui order_id ainda
    const initialLog = parsedLogs.find(
      (l) => l.msg === 'Início da requisição antes do order_id',
    );
    expect(initialLog).toBeDefined();
    expect(initialLog?.order_id).toBeUndefined();

    // O segundo log do controller deve conter order_id propagado via AsyncLocalStorage
    const afterOrderLog = parsedLogs.find(
      (l) => l.msg === 'Após associar order_id ao fluxo assíncrono',
    );
    expect(afterOrderLog).toBeDefined();
    expect(afterOrderLog?.order_id).toBe('ord-real-999');

    // O log do HttpLoggingInterceptor deve conter status_code 200, duration_ms e order_id
    const httpCompletionLog = parsedLogs.find(
      (l) => l.msg === 'HTTP Request Completed',
    );
    expect(httpCompletionLog).toBeDefined();
    expect(httpCompletionLog?.status_code).toBe(200);
    expect(httpCompletionLog?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(httpCompletionLog?.order_id).toBe('ord-real-999');
  });
});
