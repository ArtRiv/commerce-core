import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { ProductStatus } from '../generated/prisma/enums';
import type {
  ShippingOption,
  ShippingQuoteRequest,
} from '../shipping/shipping-provider';
import type { CartService, CartView } from './cart.service';
import {
  itemsSubtotalCents,
  ShippingQuoteService,
} from './shipping-quote.service';

const DEFAULT_WEIGHT_GRAMS = 500;

const OPTION: ShippingOption = {
  code: 'padrao-sul',
  label: 'Entrega padrão',
  priceCents: 1_990,
  estimatedDays: 8,
  carrier: null,
};

function cartItem(
  productId: string,
  quantity: number,
  priceCents: number,
  weightGrams: number | null = null,
): CartView['items'][number] {
  return {
    productId,
    quantity,
    product: {
      id: productId,
      name: `Product ${productId}`,
      slug: productId,
      priceCents,
      status: ProductStatus.ACTIVE,
      stockQuantity: 10,
      weightGrams,
    },
  };
}

function createMocks(items: CartView['items'] = [cartItem('p1', 2, 1_000)]) {
  const carts = {
    getCart: jest
      .fn<Promise<CartView>, [string]>()
      .mockResolvedValue({ items }),
  };
  const provider = {
    quote: jest
      .fn<Promise<ShippingOption[]>, [ShippingQuoteRequest]>()
      .mockResolvedValue([OPTION]),
  };

  return { carts, provider };
}

function serviceWith(mocks: ReturnType<typeof createMocks>) {
  return new ShippingQuoteService(
    mocks.carts as unknown as CartService,
    mocks.provider,
    DEFAULT_WEIGHT_GRAMS,
  );
}

describe('itemsSubtotalCents', () => {
  it('sums price × quantity', () => {
    expect(
      itemsSubtotalCents([
        { unitPriceCents: 1_000, quantity: 2 },
        { unitPriceCents: 2_500, quantity: 1 },
      ]),
    ).toBe(4_500);
  });

  it('is zero for nothing', () => {
    expect(itemsSubtotalCents([])).toBe(0);
  });
});

describe('ShippingQuoteService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('quoteForCart', () => {
    it('prices the caller`s own cart', async () => {
      const mocks = createMocks([
        cartItem('p1', 2, 1_000, 300),
        cartItem('p2', 1, 2_500),
      ]);

      const options = await serviceWith(mocks).quoteForCart(
        'user-1',
        '80000-000',
      );

      expect(mocks.carts.getCart).toHaveBeenCalledWith('user-1');
      expect(mocks.provider.quote).toHaveBeenCalledWith({
        destination: { postalCode: '80000-000' },
        subtotalCents: 4_500,
        items: [
          {
            productId: 'p1',
            quantity: 2,
            unitPriceCents: 1_000,
            weightGrams: 300,
          },
          {
            productId: 'p2',
            quantity: 1,
            unitPriceCents: 2_500,
            // The unweighed product resolves before the boundary.
            weightGrams: DEFAULT_WEIGHT_GRAMS,
          },
        ],
      });
      expect(options).toEqual([OPTION]);
    });

    it('409s an empty cart rather than quoting nothing', async () => {
      const mocks = createMocks([]);

      // An empty options list would read as "we do not deliver there", which
      // is a different problem with a different fix.
      await expect(
        serviceWith(mocks).quoteForCart('user-1', '80000-000'),
      ).rejects.toThrow(ConflictException);
      expect(mocks.provider.quote).not.toHaveBeenCalled();
    });

    it('passes an empty result through as a 200-able answer', async () => {
      const mocks = createMocks();
      mocks.provider.quote.mockResolvedValue([]);

      await expect(
        serviceWith(mocks).quoteForCart('user-1', '99999-999'),
      ).resolves.toEqual([]);
    });
  });

  describe('quote', () => {
    it('turns a provider failure into a 503', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const mocks = createMocks();
      mocks.provider.quote.mockRejectedValue(new Error('carrier down'));

      // "It threw" and "it returned nothing" mean different things — a
      // temporary outage versus a permanent fact about the address — and the
      // distinction has to survive to the response.
      await expect(
        serviceWith(mocks).quote('80000-000', [
          {
            productId: 'p1',
            quantity: 1,
            unitPriceCents: 1_000,
            weightGrams: null,
          },
        ]),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('select', () => {
    const service = () => serviceWith(createMocks());

    it('returns the chosen option when the asserted price still holds', () => {
      expect(service().select([OPTION], 'padrao-sul', 1_990)).toBe(OPTION);
    });

    it('409s with the current options when the price moved', () => {
      let caught: unknown;

      try {
        service().select([OPTION], 'padrao-sul', 990);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      // The only useful thing a storefront can do with this error is show the
      // options, so every refusal carries them.
      expect(caught).toMatchObject({
        response: { shippingOptions: [OPTION] },
      });
    });

    it('409s when the code is not among the options', () => {
      expect(() => service().select([OPTION], 'expressa-lua', 1_990)).toThrow(
        /not available for this address/,
      );
    });

    it('409s with a distinct message when nothing is available at all', () => {
      // True whether the cause is an unserved CEP or a parcel too heavy for
      // every option — the provider hands back the same empty list for both.
      expect(() => service().select([], 'padrao-sul', 1_990)).toThrow(
        /No delivery option is available/,
      );
    });

    it('accepts a genuinely free option', () => {
      const free = { ...OPTION, priceCents: 0 };

      // Zero is a real price here, so asserting zero has to be allowed —
      // what is rejected is a MISMATCH, not a cheap number.
      expect(service().select([free], 'padrao-sul', 0)).toBe(free);
    });

    it('refuses a zero assertion against a priced option', () => {
      // The shape a tampered request takes.
      expect(() => service().select([OPTION], 'padrao-sul', 0)).toThrow(
        ConflictException,
      );
    });
  });
});
