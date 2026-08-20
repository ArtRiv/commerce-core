import type { ShippingQuoteRequest } from './shipping-provider';
import type { ShippingTableOption } from './shipping-table';
import { TableShippingProvider } from './table-shipping.provider';

const SUDESTE: ShippingTableOption = {
  code: 'padrao-sudeste',
  label: 'Entrega padrão',
  prefixes: ['0', '1', '2', '3'],
  estimatedDays: 5,
  carrier: null,
  rates: [
    { upToGrams: 1_000, priceCents: 1_990 },
    { upToGrams: 10_000, priceCents: 2_990 },
  ],
};

const EXPRESSA_SUDESTE: ShippingTableOption = {
  code: 'expressa-sudeste',
  label: 'Entrega expressa',
  prefixes: ['0', '1'],
  estimatedDays: 2,
  carrier: 'Correios',
  rates: [{ upToGrams: 1_000, priceCents: 3_990 }],
};

const SUL: ShippingTableOption = {
  code: 'padrao-sul',
  label: 'Entrega padrão',
  prefixes: ['8', '9'],
  estimatedDays: 8,
  carrier: null,
  rates: [{ upToGrams: 10_000, priceCents: 4_990 }],
};

function request(
  overrides: Partial<ShippingQuoteRequest> = {},
): ShippingQuoteRequest {
  return {
    destination: { postalCode: '01000-000' },
    subtotalCents: 5_000,
    items: [
      {
        productId: 'p1',
        quantity: 1,
        unitPriceCents: 5_000,
        weightGrams: 500,
      },
    ],
    ...overrides,
  };
}

function providerWith(
  table: ShippingTableOption[],
  freeAboveCents: number | null = null,
) {
  return new TableShippingProvider(table, freeAboveCents);
}

describe('TableShippingProvider', () => {
  describe('matching the destination', () => {
    it('offers every option whose prefix matches, not just the most specific', async () => {
      const provider = providerWith([SUDESTE, EXPRESSA_SUDESTE, SUL]);

      const options = await provider.quote(request());

      // '0' matches both Sudeste options; the customer chooses, we do not.
      expect(options.map((option) => option.code)).toEqual([
        'padrao-sudeste',
        'expressa-sudeste',
      ]);
    });

    it('excludes options whose prefixes do not match', async () => {
      const provider = providerWith([SUDESTE, EXPRESSA_SUDESTE, SUL]);

      const options = await provider.quote(
        request({ destination: { postalCode: '80000-000' } }),
      );

      expect(options.map((option) => option.code)).toEqual(['padrao-sul']);
    });

    it('prices a hyphenated and a bare CEP identically', async () => {
      const provider = providerWith([SUDESTE]);

      const [withHyphen] = await provider.quote(
        request({ destination: { postalCode: '01000-000' } }),
      );
      const [without] = await provider.quote(
        request({ destination: { postalCode: '01000000' } }),
      );

      expect(withHyphen).toEqual(without);
    });

    it('answers "we do not deliver there" with an empty list, not an error', async () => {
      const provider = providerWith([SUL]);

      // A fact about the address. Throwing is reserved for a carrier being
      // down, and the caller turns the two into different HTTP codes.
      await expect(
        provider.quote(request({ destination: { postalCode: '01000-000' } })),
      ).resolves.toEqual([]);
    });

    it('treats a malformed CEP as unservable rather than crashing', async () => {
      const provider = providerWith([SUDESTE]);

      await expect(
        provider.quote(request({ destination: { postalCode: 'nope' } })),
      ).resolves.toEqual([]);
    });

    it('matches a longer prefix that carves out a smaller area', async () => {
      const capital: ShippingTableOption = {
        ...EXPRESSA_SUDESTE,
        code: 'moto-sp-capital',
        prefixes: ['010', '011'],
      };
      const provider = providerWith([capital]);

      await expect(
        provider.quote(request({ destination: { postalCode: '01000-000' } })),
      ).resolves.toHaveLength(1);
      await expect(
        provider.quote(request({ destination: { postalCode: '01500-000' } })),
      ).resolves.toEqual([]);
    });
  });

  describe('pricing by weight', () => {
    it('takes the first bracket that covers the parcel', async () => {
      const provider = providerWith([SUDESTE]);

      const [light] = await provider.quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 900,
            },
          ],
        }),
      );
      const [heavy] = await provider.quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 1_001,
            },
          ],
        }),
      );

      expect(light.priceCents).toBe(1_990);
      expect(heavy.priceCents).toBe(2_990);
    });

    it('treats a bracket bound as inclusive', async () => {
      const provider = providerWith([SUDESTE]);

      const [exact] = await provider.quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 1_000,
            },
          ],
        }),
      );

      expect(exact.priceCents).toBe(1_990);
    });

    it('multiplies weight by quantity across every line', async () => {
      const provider = providerWith([SUDESTE]);

      const [option] = await provider.quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 2,
              unitPriceCents: 100,
              weightGrams: 400,
            },
            {
              productId: 'p2',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 300,
            },
          ],
        }),
      );

      // 2 × 400 + 300 = 1100 g, past the first bracket.
      expect(option.priceCents).toBe(2_990);
    });

    it('drops an option whose ceiling the parcel exceeds', async () => {
      const provider = providerWith([SUDESTE, EXPRESSA_SUDESTE]);

      const options = await provider.quote(
        request({
          items: [
            {
              productId: 'p1',
              quantity: 1,
              unitPriceCents: 100,
              weightGrams: 5_000,
            },
          ],
        }),
      );

      // Expressa tops out at 1 kg. Falling back to its heaviest bracket would
      // be quoting a price we never agreed to carry.
      expect(options.map((option) => option.code)).toEqual(['padrao-sudeste']);
    });

    it('returns nothing when the parcel outweighs every option', async () => {
      const provider = providerWith([SUDESTE, EXPRESSA_SUDESTE]);

      await expect(
        provider.quote(
          request({
            items: [
              {
                productId: 'p1',
                quantity: 1,
                unitPriceCents: 100,
                weightGrams: 40_000,
              },
            ],
          }),
        ),
      ).resolves.toEqual([]);
    });
  });

  describe('free shipping', () => {
    it('zeroes every price at or above the threshold, keeping the option', async () => {
      const provider = providerWith([SUDESTE, EXPRESSA_SUDESTE], 19_900);

      const options = await provider.quote(request({ subtotalCents: 19_900 }));

      expect(options).toHaveLength(2);
      expect(options.map((option) => option.priceCents)).toEqual([0, 0]);
      // Still real options with real promises — free is a price, not an
      // absence — and once everything ties at zero the speed tiebreak takes
      // over, so the customer is offered the fastest free option first.
      expect(options.map((option) => option.code)).toEqual([
        'expressa-sudeste',
        'padrao-sudeste',
      ]);
      expect(options[0].label).toBe('Entrega expressa');
      expect(options[0].estimatedDays).toBe(2);
    });

    it('leaves prices alone below the threshold', async () => {
      const provider = providerWith([SUDESTE], 19_900);

      const [option] = await provider.quote(request({ subtotalCents: 19_899 }));

      expect(option.priceCents).toBe(1_990);
    });

    it('measures the threshold against the items, never the freight', async () => {
      const provider = providerWith([SUDESTE], 5_000);

      // subtotalCents is the items' sum: a threshold that counted freight
      // toward itself would be circular.
      const [option] = await provider.quote(request({ subtotalCents: 5_000 }));

      expect(option.priceCents).toBe(0);
    });

    it('does nothing when no threshold is configured', async () => {
      const provider = providerWith([SUDESTE], null);

      const [option] = await provider.quote(
        request({ subtotalCents: 1_000_000 }),
      );

      expect(option.priceCents).toBe(1_990);
    });
  });

  describe('ordering', () => {
    it('sorts by price, then by speed, then by code', async () => {
      const sameEverything: ShippingTableOption = {
        ...SUDESTE,
        code: 'aaa-mesmo-preco',
        label: 'Outra',
        estimatedDays: 5,
      };
      const provider = providerWith([
        EXPRESSA_SUDESTE,
        SUDESTE,
        sameEverything,
      ]);

      const options = await provider.quote(request());

      // Cheapest first; the two 1990s tie on price and speed, so the code
      // breaks it — arbitrary, but TOTAL, so a storefront preselecting "the
      // first one" never appears to change its mind on its own.
      expect(options.map((option) => option.code)).toEqual([
        'aaa-mesmo-preco',
        'padrao-sudeste',
        'expressa-sudeste',
      ]);
    });

    it('sorts an option with no estimate last among equals', async () => {
      const unknownEta: ShippingTableOption = {
        ...SUDESTE,
        code: 'sem-prazo',
        estimatedDays: null,
      };
      const provider = providerWith([unknownEta, SUDESTE]);

      const options = await provider.quote(request());

      expect(options.map((option) => option.code)).toEqual([
        'padrao-sudeste',
        'sem-prazo',
      ]);
    });
  });

  it('passes the carrier through untouched', async () => {
    const provider = providerWith([EXPRESSA_SUDESTE]);

    const [option] = await provider.quote(request());

    expect(option.carrier).toBe('Correios');
  });
});
