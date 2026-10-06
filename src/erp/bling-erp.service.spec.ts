import type { ConfigService } from '@nestjs/config';

import { BlingErpService } from './bling-erp.service';
import type { CanonicalOrder } from './erp-service';
import { NoOpErpService } from './no-op-erp.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key] ?? undefined,
    getOrThrow: (key: string) => {
      const val = values[key];
      if (!val) throw new Error(`Missing required config: ${key}`);
      return val;
    },
  } as unknown as ConfigService;
}

function order(overrides: Partial<CanonicalOrder> = {}): CanonicalOrder {
  return {
    id: 'order-uuid-abc',
    totalCents: 12_990,
    itemsSubtotalCents: 10_000,
    shippingCents: 2_990,
    shippingMethodName: 'PAC',
    paidAt: new Date('2026-10-04T15:00:00Z'),
    buyer: { name: 'Teste Silva', email: 'teste@example.com' },
    address: {
      street: 'Rua das Flores',
      number: '100',
      complement: 'Apto 1',
      neighborhood: 'Centro',
      city: 'Curitiba',
      state: 'PR',
      postalCode: '80000-000',
    },
    items: [
      {
        variantId: 'variant-1',
        productName: 'Camiseta Preta',
        variantLabel: 'M',
        unitPriceCents: 5_000,
        quantity: 2,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BlingErpService
// ---------------------------------------------------------------------------

describe('BlingErpService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('fetch not mocked')));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const cfg = config({ BLING_API_KEY: 'test-api-key' });

  describe('exportOrder — success', () => {
    it('returns the erpOrderId from Bling on a successful POST', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 12345 } }),
      });

      const service = new BlingErpService(cfg);
      const result = await service.exportOrder(order());

      expect(result.erpOrderId).toBe('12345');
    });

    it('sends the order id as numeroPedidoCompra in the payload', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 1 } }),
      });

      const service = new BlingErpService(cfg);
      await service.exportOrder(order({ id: 'my-order-id' }));

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        numeroPedidoCompra: string;
      };

      expect(body.numeroPedidoCompra).toBe('my-order-id');
    });

    it('maps items to Bling format with BRL values (not cents)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 1 } }),
      });

      const service = new BlingErpService(cfg);
      await service.exportOrder(
        order({
          items: [
            {
              variantId: 'v1',
              productName: 'Camiseta',
              variantLabel: 'G',
              unitPriceCents: 7_990,
              quantity: 1,
            },
          ],
        }),
      );

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        itens: Array<{ valor: number; quantidade: number }>;
      };

      expect(body.itens[0].valor).toBeCloseTo(79.9, 2);
      expect(body.itens[0].quantidade).toBe(1);
    });

    it('maps shipping cents to BRL in the transporte.frete field', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 1 } }),
      });

      const service = new BlingErpService(cfg);
      await service.exportOrder(order({ shippingCents: 2_490 }));

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        transporte: { frete: number };
      };

      expect(body.transporte.frete).toBeCloseTo(24.9, 2);
    });

    it('includes the loja id when BLING_STORE_ID is configured', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 1 } }),
      });

      const service = new BlingErpService(
        config({ BLING_API_KEY: 'key', BLING_STORE_ID: '999' }),
      );
      await service.exportOrder(order());

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        loja?: { id: number };
      };

      expect(body.loja?.id).toBe(999);
    });
  });

  describe('exportOrder — HTTP errors', () => {
    it('throws on HTTP 401 (invalid or expired API key)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const service = new BlingErpService(cfg);
      await expect(service.exportOrder(order())).rejects.toThrow('HTTP 401');
    });

    it('throws on HTTP 429 (rate limit exceeded)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });

      const service = new BlingErpService(cfg);
      await expect(service.exportOrder(order())).rejects.toThrow('HTTP 429');
    });

    it('throws on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('network error'));

      const service = new BlingErpService(cfg);
      await expect(service.exportOrder(order())).rejects.toThrow(
        'network error',
      );
    });

    it('throws when Bling returns 200 but no id in the response body', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      const service = new BlingErpService(cfg);
      await expect(service.exportOrder(order())).rejects.toThrow(
        'não retornou ID',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// NoOpErpService
// ---------------------------------------------------------------------------

describe('NoOpErpService', () => {
  it('resolves without calling the network', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const service = new NoOpErpService();

    const result = await service.exportOrder(order());

    expect(result.erpOrderId).toBe('noop');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('never throws regardless of input', async () => {
    const service = new NoOpErpService();
    // Even with a completely empty order, it should not throw.
    await expect(
      service.exportOrder({} as CanonicalOrder),
    ).resolves.toBeDefined();
  });
});
