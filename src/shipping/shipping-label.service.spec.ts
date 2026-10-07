import type { LabelPurchaseInput } from './shipping-label.service';
import { ShippingLabelService } from './shipping-label.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://melhorenvio.com.br/api';
const TOKEN = 'test-token';

function service() {
  return new ShippingLabelService(TOKEN, BASE_URL);
}

function input(
  overrides: Partial<LabelPurchaseInput> = {},
): LabelPurchaseInput {
  return {
    orderId: 'order-uuid-123',
    serviceCode: 'melhorenvio.1',
    totalWeightGrams: 500,
    heightCm: 10,
    widthCm: 15,
    lengthCm: 20,
    insuranceValueBrl: 99.9,
    origin: {
      postalCode: '01001000',
      name: 'Avesso Store',
      phone: '11999999999',
    },
    destination: {
      postalCode: '80000-000',
      name: 'Cliente Teste',
      address: 'Rua das Flores',
      number: '100',
      complement: 'Apto 1',
      neighborhood: 'Centro',
      city: 'Curitiba',
      stateAbbr: 'PR',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ShippingLabelService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('fetch not mocked')));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('purchase — happy path', () => {
    it('returns trackingCode and labelUrl after three successful API calls', async () => {
      // Call 1: POST /v2/me/cart
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42 }),
      });

      // Call 2: POST /v2/me/shipment/checkout
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          purchase: { id: 99, orders: [{ id: 77, tracking: 'BR123456789BR' }] },
        }),
      });

      // Call 3: GET /v2/me/shipment/77/generate
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://melhorenvio.com.br/labels/77.pdf' }),
      });

      const result = await service().purchase(input());

      expect(result.trackingCode).toBe('BR123456789BR');
      expect(result.labelUrl).toBe('https://melhorenvio.com.br/labels/77.pdf');
      expect(result.melhorEnvioShipmentId).toBe('77');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('sends the order id in the cart item tags', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            purchase: { id: 1, orders: [{ id: 1, tracking: 'T' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: 'http://x' }),
        });

      await service().purchase(input({ orderId: 'my-order-id' }));

      const [, cartInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(cartInit.body as string) as {
        options: { tags: Array<{ tag: string }> };
      };

      expect(body.options.tags[0].tag).toBe('my-order-id');
    });

    it('maps weight from grams to kg in the volume', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            purchase: { id: 1, orders: [{ id: 1, tracking: 'T' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: 'http://x' }),
        });

      await service().purchase(input({ totalWeightGrams: 750 }));

      const [, cartInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(cartInit.body as string) as {
        volumes: Array<{ weight: number }>;
      };

      expect(body.volumes[0].weight).toBeCloseTo(0.75, 2);
    });
  });

  describe('purchase — failures', () => {
    it('throws when the cart endpoint returns non-2xx', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Unprocessable',
      });

      await expect(service().purchase(input())).rejects.toThrow('HTTP 422');
    });

    it('throws when the checkout endpoint returns non-2xx', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 1 }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 402,
          text: async () => 'Insufficient balance',
        });

      await expect(service().purchase(input())).rejects.toThrow('HTTP 402');
    });

    it('throws when the generate endpoint returns no url', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ id: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            purchase: { id: 1, orders: [{ id: 1, tracking: 'T' }] },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        });

      await expect(service().purchase(input())).rejects.toThrow(
        'não retornou URL de etiqueta',
      );
    });
  });

  describe('service code parsing', () => {
    it('throws on an invalid service code format', async () => {
      await expect(
        service().purchase(input({ serviceCode: 'invalid-code' })),
      ).rejects.toThrow('Código de serviço inválido');
    });

    it('throws on a melhorenvio code with a non-numeric id', async () => {
      await expect(
        service().purchase(input({ serviceCode: 'melhorenvio.abc' })),
      ).rejects.toThrow('Código de serviço inválido');
    });
  });
});
