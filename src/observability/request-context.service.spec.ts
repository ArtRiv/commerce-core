import { RequestContextService } from './request-context.service';

describe('RequestContextService (AsyncLocalStorage)', () => {
  let service: RequestContextService;

  beforeEach(() => {
    service = new RequestContextService();
  });

  it('deve retornar undefined quando fora de qualquer contexto de execução', () => {
    expect(service.getStore()).toBeUndefined();
    expect(service.getCorrelationId()).toBeUndefined();
    expect(service.getTenantId()).toBeUndefined();
    expect(service.getOrderId()).toBeUndefined();
  });

  it('deve disponibilizar dados de contexto dentro do callback de run()', () => {
    service.run(
      {
        correlationId: 'req-abc-123',
        tenantId: 'tenant-loja-1',
        orderId: 'order-xyz-789',
        userId: 'user-456',
      },
      () => {
        expect(service.getCorrelationId()).toBe('req-abc-123');
        expect(service.getTenantId()).toBe('tenant-loja-1');
        expect(service.getOrderId()).toBe('order-xyz-789');
        expect(service.getStore()?.userId).toBe('user-456');

        // Métodos estáticos também devem refletir o mesmo store
        expect(RequestContextService.getCorrelationId()).toBe('req-abc-123');
        expect(RequestContextService.getTenantId()).toBe('tenant-loja-1');
        expect(RequestContextService.getOrderId()).toBe('order-xyz-789');
      },
    );

    // Fora do run(), volta a ser undefined
    expect(service.getStore()).toBeUndefined();
  });

  it('deve permitir atualizar dinamicamente tenant_id e order_id dentro do contexto', () => {
    service.run({ correlationId: 'req-init' }, () => {
      expect(service.getTenantId()).toBeUndefined();
      expect(service.getOrderId()).toBeUndefined();

      service.setTenantId('tenant-dinamico');
      service.setOrderId('order-dinamico');
      service.setUserId('user-dinamico');
      service.set('customKey', 'customValue');

      expect(service.getTenantId()).toBe('tenant-dinamico');
      expect(service.getOrderId()).toBe('order-dinamico');
      expect(service.getStore()?.userId).toBe('user-dinamico');
      expect(service.get('customKey')).toBe('customValue');
    });
  });

  it('deve isolar contextos em execuções assíncronas paralelas', async () => {
    const tarefa1 = async () => {
      return service.run(
        { correlationId: 'req-1', tenantId: 'tenant-1', orderId: 'order-1' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return {
            cid: service.getCorrelationId(),
            tid: service.getTenantId(),
            oid: service.getOrderId(),
          };
        },
      );
    };

    const tarefa2 = async () => {
      return service.run(
        { correlationId: 'req-2', tenantId: 'tenant-2', orderId: 'order-2' },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            cid: service.getCorrelationId(),
            tid: service.getTenantId(),
            oid: service.getOrderId(),
          };
        },
      );
    };

    const [res1, res2] = await Promise.all([tarefa1(), tarefa2()]);

    expect(res1).toEqual({
      cid: 'req-1',
      tid: 'tenant-1',
      oid: 'order-1',
    });
    expect(res2).toEqual({
      cid: 'req-2',
      tid: 'tenant-2',
      oid: 'order-2',
    });
  });
});
