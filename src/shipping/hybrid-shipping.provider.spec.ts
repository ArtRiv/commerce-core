import { ServiceUnavailableException } from '@nestjs/common';

import { HybridShippingProvider } from './hybrid-shipping.provider';
import type {
  ShippingOption,
  ShippingProvider,
  ShippingQuoteRequest,
} from './shipping-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(): ShippingQuoteRequest {
  return {
    destination: { postalCode: '01000-000' },
    subtotalCents: 5_000,
    items: [
      { productId: 'p1', quantity: 1, unitPriceCents: 5_000, weightGrams: 300 },
    ],
  };
}

const OPTION_A: ShippingOption = {
  code: 'melhorenvio.1',
  label: 'PAC — Correios',
  priceCents: 1_500,
  estimatedDays: 5,
  carrier: 'Correios',
};

const OPTION_B: ShippingOption = {
  code: 'padrao-sudeste',
  label: 'Entrega padrão',
  priceCents: 1_990,
  estimatedDays: 6,
  carrier: null,
};

function makeProvider(options: ShippingOption[]): ShippingProvider {
  return { quote: jest.fn().mockResolvedValue(options) };
}

function makeFailingProvider(error: Error): ShippingProvider {
  return { quote: jest.fn().mockRejectedValue(error) };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('HybridShippingProvider', () => {
  it('returns the primary result when it succeeds', async () => {
    const primary = makeProvider([OPTION_A]);
    const fallback = makeProvider([OPTION_B]);
    const hybrid = new HybridShippingProvider(primary, fallback);

    const result = await hybrid.quote(request());

    expect(result).toEqual([OPTION_A]);
    expect(fallback.quote).not.toHaveBeenCalled();
  });

  it('falls back to the table provider when the primary throws ServiceUnavailableException', async () => {
    const primary = makeFailingProvider(
      new ServiceUnavailableException('Melhor Envio down'),
    );
    const fallback = makeProvider([OPTION_B]);
    const hybrid = new HybridShippingProvider(primary, fallback);

    const result = await hybrid.quote(request());

    expect(result).toEqual([OPTION_B]);
  });

  it('falls back when the primary throws any error (network timeout, etc.)', async () => {
    const primary = makeFailingProvider(new TypeError('fetch failed'));
    const fallback = makeProvider([OPTION_B]);
    const hybrid = new HybridShippingProvider(primary, fallback);

    const result = await hybrid.quote(request());

    expect(result).toEqual([OPTION_B]);
  });

  it('returns an empty list from the primary without hitting the fallback', async () => {
    // An empty list means "carrier does not deliver there" — a fact about
    // the address. The fallback is unlikely to serve it either, and mixing
    // carrier services with table entries would be confusing.
    const primary = makeProvider([]);
    const fallback = makeProvider([OPTION_B]);
    const hybrid = new HybridShippingProvider(primary, fallback);

    const result = await hybrid.quote(request());

    expect(result).toEqual([]);
    expect(fallback.quote).not.toHaveBeenCalled();
  });

  it('propagates the fallback error if the fallback also fails', async () => {
    const primary = makeFailingProvider(
      new ServiceUnavailableException('ME down'),
    );
    const fallback = makeFailingProvider(
      new ServiceUnavailableException('Table broken'),
    );
    const hybrid = new HybridShippingProvider(primary, fallback);

    await expect(hybrid.quote(request())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
