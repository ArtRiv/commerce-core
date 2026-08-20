import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import {
  resolveDefaultWeightGrams,
  resolveFreeAboveCents,
  resolveShippingTable,
} from './shipping.module';
import { DEFAULT_SHIPPING_TABLE } from './shipping-table';

/** A ConfigService that only knows the variables a test hands it. */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const ONE_OPTION = JSON.stringify([
  {
    code: 'unica',
    label: 'Entrega',
    prefixes: ['8'],
    estimatedDays: 3,
    rates: [{ upToGrams: 1000, priceCents: 1500 }],
  },
]);

describe('resolveShippingTable', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the configured table whatever the environment', () => {
    const table = resolveShippingTable(
      configWith({ SHIPPING_TABLE: ONE_OPTION, NODE_ENV: 'production' }),
    );

    expect(table).toHaveLength(1);
    expect(table[0].code).toBe('unica');
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets an invalid table fail the boot instead of half-applying it', () => {
    expect(() =>
      resolveShippingTable(
        configWith({
          SHIPPING_TABLE: '[{"code":"x"}]',
          NODE_ENV: 'production',
        }),
      ),
    ).toThrow(/SHIPPING_TABLE is invalid/);
  });

  it.each(['development', 'test'])(
    'falls back to the built-in table in %s, loudly',
    (environment) => {
      const table = resolveShippingTable(configWith({ NODE_ENV: environment }));

      expect(table).toBe(DEFAULT_SHIPPING_TABLE);
      // A fresh clone gets a working checkout; the warning is what stops
      // those placeholder prices from being mistaken for real ones.
      expect(warn).toHaveBeenCalled();
    },
  );

  it.each([
    ['production', 'production'],
    ['staging', 'staging'],
    ['prod', 'prod'],
    ['unset', undefined],
    ['Production (any casing of a non-listed value)', 'Production'],
  ])('refuses to boot with no table when NODE_ENV is %s', (_label, value) => {
    // An allow-list, not a deny-list, exactly as payments argues: the cost of
    // guessing wrong is a store charging invented freight on every order, and
    // "NODE_ENV happened to be unset on this box" is not a reason to start.
    expect(() => resolveShippingTable(configWith({ NODE_ENV: value }))).toThrow(
      /SHIPPING_TABLE is required/,
    );
  });

  it('names what it found, so the failure is actionable', () => {
    expect(() =>
      resolveShippingTable(configWith({ NODE_ENV: 'staging' })),
    ).toThrow(/NODE_ENV is 'staging'/);
    expect(() => resolveShippingTable(configWith({}))).toThrow(
      /NODE_ENV is unset/,
    );
  });

  it('reads the allow-list case- and whitespace-insensitively', () => {
    // Same normalisation payments applies, so the two guards cannot disagree
    // about what environment this is.
    expect(
      resolveShippingTable(configWith({ NODE_ENV: ' Development ' })),
    ).toBe(DEFAULT_SHIPPING_TABLE);
  });

  it('treats a blank table as no table at all', () => {
    expect(() =>
      resolveShippingTable(
        configWith({ SHIPPING_TABLE: '   ', NODE_ENV: 'production' }),
      ),
    ).toThrow(/SHIPPING_TABLE is required/);
  });
});

describe('resolveFreeAboveCents', () => {
  it('is null when unset or blank — which is not the same as zero', () => {
    // Zero would make everything free; absent means the rule is off.
    expect(resolveFreeAboveCents(configWith({}))).toBeNull();
    expect(
      resolveFreeAboveCents(configWith({ SHIPPING_FREE_ABOVE_CENTS: '  ' })),
    ).toBeNull();
  });

  it('reads a whole number of cents', () => {
    expect(
      resolveFreeAboveCents(configWith({ SHIPPING_FREE_ABOVE_CENTS: '19900' })),
    ).toBe(19900);
    expect(
      resolveFreeAboveCents(configWith({ SHIPPING_FREE_ABOVE_CENTS: '0' })),
    ).toBe(0);
  });

  it.each(['19900.5', '-1', 'grátis'])('refuses %s', (value) => {
    expect(() =>
      resolveFreeAboveCents(configWith({ SHIPPING_FREE_ABOVE_CENTS: value })),
    ).toThrow(/whole number of cents/);
  });
});

describe('resolveDefaultWeightGrams', () => {
  it('defaults to 500 g', () => {
    expect(resolveDefaultWeightGrams(configWith({}))).toBe(500);
  });

  it('reads a configured weight', () => {
    expect(
      resolveDefaultWeightGrams(
        configWith({ SHIPPING_DEFAULT_WEIGHT_GRAMS: '750' }),
      ),
    ).toBe(750);
  });

  it.each(['0', '-1', '1.5', 'pesado'])('refuses %s', (value) => {
    // Zero would quote every unweighed parcel as weightless, which is the
    // cheapest bracket on every option — silently, on every order.
    expect(() =>
      resolveDefaultWeightGrams(
        configWith({ SHIPPING_DEFAULT_WEIGHT_GRAMS: value }),
      ),
    ).toThrow(/whole number of grams above 0/);
  });
});
