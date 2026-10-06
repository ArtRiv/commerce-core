import { ServiceUnavailableException } from '@nestjs/common';

import { MelhorEnvioShippingProvider } from './melhor-envio-shipping.provider';
import type { ShippingQuoteRequest } from './shipping-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'https://melhorenvio.com.br/api';
const TOKEN = 'test-token-abc';
const ORIGIN_CEP = '01001000';

function provider(baseUrl = BASE_URL) {
  return new MelhorEnvioShippingProvider(TOKEN, ORIGIN_CEP, baseUrl);
}

function request(
  overrides: Partial<ShippingQuoteRequest> = {},
): ShippingQuoteRequest {
  return {
    destination: { postalCode: '80000-000' },
    subtotalCents: 10_000,
    items: [
      {
        productId: 'p1',
        quantity: 1,
        unitPriceCents: 10_000,
        weightGrams: 500,
        heightCm: 10,
        widthCm: 15,
        lengthCm: 20,
      },
    ],
    ...overrides,
  };
}

// Minimal Melhor Envio service response fixture.
function serviceFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'PAC',
    price: '19.90',
    custom_price: null,
    discount: null,
    currency: 'BRL',
    delivery_time: 5,
    delivery_range: { min: 4, max: 6 },
    custom_delivery_time: 0,
    custom_delivery_range: { min: 0, max: 0 },
    packages: [],
    additional_services: { receipt: false, own_hand: false, collect: false },
    company: { id: 1, name: 'Correios', picture: '' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MelhorEnvioShippingProvider', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('fetch not mocked')));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Successful responses
  // -------------------------------------------------------------------------

  describe('quote — successful responses', () => {
    it('maps a single service to a ShippingOption with the correct code and price', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [serviceFixture()],
      });

      const [option] = await provider().quote(request());

      expect(option.code).toBe('melhorenvio.1');
      expect(option.label).toBe('PAC — Correios');
      expect(option.priceCents).toBe(1_990);
      expect(option.estimatedDays).toBe(5);
      expect(option.carrier).toBe('Correios');
    });

    it('prefers custom_price over price when both are present', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          serviceFixture({ price: '19.90', custom_price: '14.50' }),
        ],
      });

      const [option] = await provider().quote(request());

      expect(option.priceCents).toBe(1_450);
    });

    it('prefers custom_delivery_time over delivery_time when set', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [serviceFixture({ custom_delivery_time: 3 })],
      });

      const [option] = await provider().quote(request());

      expect(option.estimatedDays).toBe(3);
    });

    it('filters out services with an error field', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          serviceFixture({ id: 1 }),
          serviceFixture({ id: 2, error: 'CEP não atendido', price: null }),
          serviceFixture({ id: 3, name: 'SEDEX', price: '34.90' }),
        ],
      });

      const options = await provider().quote(request());

      expect(options).toHaveLength(2);
      expect(options.map((o) => o.code)).toEqual([
        'melhorenvio.1',
        'melhorenvio.3',
      ]);
    });

    it('filters out services with null price', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [serviceFixture({ price: null, custom_price: null })],
      });

      const options = await provider().quote(request());

      expect(options).toHaveLength(0);
    });

    it('returns an empty list for a malformed CEP without calling the API', async () => {
      const options = await provider().quote(
        request({ destination: { postalCode: 'not-a-cep' } }),
      );

      expect(options).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Package consolidation
  // -------------------------------------------------------------------------

  describe('package consolidation', () => {
    it('sends a POST to the calculate endpoint with consolidated dimensions', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await provider().quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 2,
              unitPriceCents: 100,
              weightGrams: 300,
              heightCm: 15,
              widthCm: 20,
              lengthCm: 30,
            },
            {
              productId: 'p2',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 200,
              heightCm: 10,
              widthCm: 25,
              lengthCm: 25,
            },
          ],
        }),
      );

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        package: {
          weight: number;
          height: number;
          width: number;
          length: number;
        };
      };

      // Max height = 15, max width = 25, max length = 30.
      expect(body.package.height).toBe(15);
      expect(body.package.width).toBe(25);
      expect(body.package.length).toBe(30);
      // Total weight: 2×300 + 1×200 = 800g = 0.800 kg.
      expect(body.package.weight).toBeCloseTo(0.8, 2);
    });

    it('enforces a minimum weight of 0.1 kg', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      await provider().quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 50,
            },
          ],
        }),
      );

      const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(callInit.body as string) as {
        package: { weight: number };
      };

      expect(body.package.weight).toBeGreaterThanOrEqual(0.1);
    });
  });

  // -------------------------------------------------------------------------
  // Network failures
  // -------------------------------------------------------------------------

  describe('network failures', () => {
    it('throws ServiceUnavailableException on a non-2xx response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      });

      await expect(provider().quote(request())).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws ServiceUnavailableException on a network error', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(provider().quote(request())).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws ServiceUnavailableException on timeout', async () => {
      fetchSpy.mockRejectedValueOnce(
        new DOMException('The operation was aborted', 'AbortError'),
      );

      await expect(provider().quote(request())).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Authorization header
  // -------------------------------------------------------------------------

  it('sends the Bearer token in the Authorization header', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await provider().quote(request());

    const [, callInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = callInit.headers as Record<string, string>;

    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});
