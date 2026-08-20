import {
  DEFAULT_SHIPPING_TABLE,
  normalizePostalCode,
  parseShippingTable,
} from './shipping-table';

/** A minimal valid option, spread over in the tests that break one rule. */
const VALID_OPTION = {
  code: 'padrao-sudeste',
  label: 'Entrega padrão',
  prefixes: ['0', '1'],
  estimatedDays: 5,
  rates: [{ upToGrams: 1000, priceCents: 1990 }],
};

function tableOf(...options: unknown[]): string {
  return JSON.stringify(options);
}

describe('parseShippingTable', () => {
  it('reads a complete option', () => {
    const [option] = parseShippingTable(
      tableOf({
        ...VALID_OPTION,
        carrier: 'Correios',
        rates: [
          { upToGrams: 1000, priceCents: 1990 },
          { upToGrams: 30000, priceCents: 3990 },
        ],
      }),
    );

    expect(option).toEqual({
      code: 'padrao-sudeste',
      label: 'Entrega padrão',
      prefixes: ['0', '1'],
      estimatedDays: 5,
      carrier: 'Correios',
      rates: [
        { upToGrams: 1000, priceCents: 1990 },
        { upToGrams: 30000, priceCents: 3990 },
      ],
    });
  });

  it('defaults the optional fields to null rather than dropping them', () => {
    const [option] = parseShippingTable(
      tableOf({
        code: 'retirada',
        label: 'Retirada',
        prefixes: ['8'],
        rates: [{ upToGrams: 30000, priceCents: 0 }],
      }),
    );

    expect(option.estimatedDays).toBeNull();
    expect(option.carrier).toBeNull();
  });

  it('accepts a zero-cost bracket', () => {
    // A promotional free bracket is a real business rule, unlike a negative
    // price, which is the store paying the customer to take the parcel.
    expect(() =>
      parseShippingTable(
        tableOf({
          ...VALID_OPTION,
          rates: [{ upToGrams: 500, priceCents: 0 }],
        }),
      ),
    ).not.toThrow();
  });

  describe('refuses to boot on', () => {
    it('malformed JSON', () => {
      expect(() => parseShippingTable('{not json')).toThrow(/not valid JSON/);
    });

    it('a JSON value that is not a non-empty array', () => {
      expect(() => parseShippingTable('[]')).toThrow(/non-empty JSON array/);
      expect(() => parseShippingTable('{}')).toThrow(/non-empty JSON array/);
    });

    it('a duplicated code', () => {
      // Checkout resolves an order's freight BY code; the wrong one silently
      // winning is a wrong charge.
      expect(() =>
        parseShippingTable(tableOf(VALID_OPTION, { ...VALID_OPTION })),
      ).toThrow(/"padrao-sudeste" appears more than once/);
    });

    it('a missing code or label', () => {
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, code: '  ' })),
      ).toThrow(/option #1 needs a non-empty "code"/);
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, label: '' })),
      ).toThrow(/needs a non-empty "label"/);
    });

    it('prefixes that are not digits', () => {
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, prefixes: ['SP'] })),
      ).toThrow(/prefixes must be 1 to 8 digits/);
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, prefixes: [] })),
      ).toThrow(/non-empty "prefixes" array/);
      expect(() =>
        parseShippingTable(
          tableOf({ ...VALID_OPTION, prefixes: ['123456789'] }),
        ),
      ).toThrow(/prefixes must be 1 to 8 digits/);
    });

    it('brackets that do not ascend', () => {
      // Pricing takes the FIRST bracket that covers the parcel, so an
      // out-of-order table quietly returns the wrong price instead of failing.
      expect(() =>
        parseShippingTable(
          tableOf({
            ...VALID_OPTION,
            rates: [
              { upToGrams: 30000, priceCents: 3990 },
              { upToGrams: 1000, priceCents: 1990 },
            ],
          }),
        ),
      ).toThrow(/brackets must ascend/);
    });

    it('a repeated bracket bound', () => {
      expect(() =>
        parseShippingTable(
          tableOf({
            ...VALID_OPTION,
            rates: [
              { upToGrams: 1000, priceCents: 1990 },
              { upToGrams: 1000, priceCents: 2990 },
            ],
          }),
        ),
      ).toThrow(/brackets must ascend/);
    });

    it('a non-positive weight or a negative price', () => {
      expect(() =>
        parseShippingTable(
          tableOf({
            ...VALID_OPTION,
            rates: [{ upToGrams: 0, priceCents: 1990 }],
          }),
        ),
      ).toThrow(/"upToGrams" greater than 0/);
      expect(() =>
        parseShippingTable(
          tableOf({
            ...VALID_OPTION,
            rates: [{ upToGrams: 1000, priceCents: -1 }],
          }),
        ),
      ).toThrow(/"priceCents" of 0 or more/);
    });

    it('a fractional weight bound', () => {
      expect(() =>
        parseShippingTable(
          tableOf({
            ...VALID_OPTION,
            rates: [{ upToGrams: 1000.5, priceCents: 1990 }],
          }),
        ),
      ).toThrow(/integer "upToGrams"/);
    });

    it('missing rates', () => {
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, rates: [] })),
      ).toThrow(/non-empty "rates" array/);
    });

    it('an estimate or carrier of the wrong type', () => {
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, estimatedDays: -1 })),
      ).toThrow(/whole number of days/);
      expect(() =>
        parseShippingTable(tableOf({ ...VALID_OPTION, carrier: 42 })),
      ).toThrow(/"carrier" to be a string/);
    });

    it('an option that is not an object at all', () => {
      expect(() => parseShippingTable(tableOf('padrao'))).toThrow(
        /option #1 must be an object/,
      );
    });
  });

  it('names the offending option, because a boot failure has to be actionable', () => {
    expect(() =>
      parseShippingTable(
        tableOf(VALID_OPTION, {
          ...VALID_OPTION,
          code: 'expressa',
          rates: [{ upToGrams: 1000, priceCents: -5 }],
        }),
      ),
    ).toThrow(/option "expressa" rate #1/);
  });
});

describe('normalizePostalCode', () => {
  it('accepts a CEP with or without punctuation, and answers the same', () => {
    expect(normalizePostalCode('80000-000')).toBe('80000000');
    expect(normalizePostalCode('80000000')).toBe('80000000');
    expect(normalizePostalCode(' 80.000-000 ')).toBe('80000000');
  });

  it('rejects anything that is not eight digits', () => {
    expect(normalizePostalCode('8000-000')).toBeNull();
    expect(normalizePostalCode('800000000')).toBeNull();
    expect(normalizePostalCode('CEP')).toBeNull();
    expect(normalizePostalCode('')).toBeNull();
  });
});

describe('DEFAULT_SHIPPING_TABLE', () => {
  it('satisfies the same rules a configured table must', () => {
    // The built-in table is what a fresh clone runs on, so it has to survive
    // its own validator — a broken default would only surface on someone
    // else's machine.
    expect(() =>
      parseShippingTable(JSON.stringify(DEFAULT_SHIPPING_TABLE)),
    ).not.toThrow();
  });

  it('covers every CEP region', () => {
    const covered = DEFAULT_SHIPPING_TABLE.flatMap(
      (option) => option.prefixes,
    ).sort();

    expect(covered).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
});
