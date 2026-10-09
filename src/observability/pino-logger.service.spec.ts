import { Writable } from 'node:stream';

import { PinoLoggerService } from './pino-logger.service';
import { RequestContextService } from './request-context.service';

describe('PinoLoggerService', () => {
  let contextService: RequestContextService;
  let logOutput: string[];
  let testStream: Writable;
  let logger: PinoLoggerService;

  beforeEach(() => {
    contextService = new RequestContextService();
    logOutput = [];
    testStream = new Writable({
      write(chunk, encoding, callback) {
        logOutput.push(chunk.toString());
        callback();
      },
    });

    logger = new PinoLoggerService({
      level: 'trace',
      stream: testStream,
      pretty: false,
    });
  });

  const getLastLog = (): Record<string, any> => {
    expect(logOutput.length).toBeGreaterThan(0);
    return JSON.parse(logOutput[logOutput.length - 1]);
  };

  it('deve emitir log JSON simples com mensagem e level correspondente', () => {
    logger.log('Hello world');
    const log = getLastLog();
    expect(log.msg).toBe('Hello world');
    expect(log.level).toBe(30); // info
  });

  it('deve injetar automaticamente tenant_id e order_id do AsyncLocalStorage', () => {
    contextService.run(
      {
        correlationId: 'corr-123',
        tenantId: 'loja-avesso',
        orderId: 'order-xyz-99',
        userId: 'user-arthur',
      },
      () => {
        logger.log('Pedido processado com sucesso');
        const log = getLastLog();

        expect(log.msg).toBe('Pedido processado com sucesso');
        expect(log.tenant_id).toBe('loja-avesso');
        expect(log.order_id).toBe('order-xyz-99');
        expect(log.correlation_id).toBe('corr-123');
        expect(log.user_id).toBe('user-arthur');
      },
    );
  });

  it('deve refletir tenant_id e order_id atualizados dinamicamente no meio da execução', () => {
    contextService.run({ correlationId: 'req-dyn' }, () => {
      logger.log('Iniciando processamento sem order_id');
      const first = getLastLog();
      expect(first.order_id).toBeUndefined();
      expect(first.tenant_id).toBeUndefined();

      contextService.setTenantId('tenant-dinamico-1');
      contextService.setOrderId('order-dinamico-99');

      logger.log('Ordem gerada na transação');
      const second = getLastLog();
      expect(second.tenant_id).toBe('tenant-dinamico-1');
      expect(second.order_id).toBe('order-dinamico-99');
      expect(second.correlation_id).toBe('req-dyn');
    });
  });

  it('deve capturar contexto informado no NestJS como parâmetro opcional', () => {
    logger.log('Mensagem com contexto', 'OrdersService');
    const log = getLastLog();
    expect(log.context).toBe('OrdersService');
  });

  it('deve capturar e formatar erros com stack trace e mensagem', () => {
    const error = new Error('Falha de conexão com gateway');
    logger.error('Erro ao processar pagamento', error.stack, 'PaymentsService');
    const log = getLastLog();

    expect(log.level).toBe(50); // error
    expect(log.msg).toBe('Erro ao processar pagamento');
    expect(log.context).toBe('PaymentsService');
    expect(log.err).toBeDefined();
    expect(log.err.stack).toContain('Falha de conexão com gateway');
  });

  it('deve redigir automaticamente campos sensíveis (password, token, secret, cvv)', () => {
    logger.log({
      msg: 'Tentativa de login',
      password: 'senhaSuperSecreta123',
      token: 'jwt.token.secreto',
      creditCard: '4111111111111234',
      cvv: '123',
      safeField: 'valorPermitido',
    });

    const log = getLastLog();
    expect(log.password).toBe('[REDACTED]');
    expect(log.token).toBe('[REDACTED]');
    expect(log.creditCard).toBe('[REDACTED]');
    expect(log.cvv).toBe('[REDACTED]');
    expect(log.safeField).toBe('valorPermitido');
  });

  it('deve suportar forContext criando logger filho com contexto padrão', () => {
    const child = logger.forContext('CatalogSync');
    child.warn('Aviso de catálogo');
    const log = getLastLog();

    expect(log.level).toBe(40); // warn
    expect(log.context).toBe('CatalogSync');
    expect(log.msg).toBe('Aviso de catálogo');
  });
});
