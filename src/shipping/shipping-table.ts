/**
 * The freight table: what SHIPPING_TABLE holds, and what it takes to be
 * believed.
 *
 * Every rule here is checked at BOOT, not at quote time, and a violation
 * throws rather than being skipped. The reason is the same one that makes
 * PaymentsModule refuse to start without Stripe outside development: a store
 * that quietly charges the wrong freight on every order is worse than one that
 * will not come up. A malformed option silently dropped at request time would
 * be exactly that — a table that looks configured and undercharges forever.
 *
 * See docs/specs/shipping.md.
 */

/** A weight bracket. The first bracket that covers the parcel sets the price. */
export interface ShippingRate {
  /** Upper bound in grams, inclusive. The last one is the option's ceiling. */
  upToGrams: number;
  /** Zero is allowed: a promotional free bracket is a real business rule. */
  priceCents: number;
}

export interface ShippingTableOption {
  code: string;
  label: string;
  /** Leading digits of the CEP this option serves. '0' … '99999999'. */
  prefixes: string[];
  estimatedDays: number | null;
  carrier: string | null;
  rates: ShippingRate[];
}

/** Brazilian CEP, with or without the hyphen: 80000-000 or 80000000. */
export const POSTAL_CODE_PATTERN = /^\d{5}-?\d{3}$/;

/**
 * The table a fresh clone gets when SHIPPING_TABLE is unset — allowed only in
 * development and test (see resolveShippingProvider), so nobody is charged
 * these numbers for real.
 *
 * The regions come from the CEP's own first digit, which already partitions
 * the country: 0-1 SP, 2 RJ/ES, 3 MG, 4 BA/SE, 5 PE/AL/PB/RN,
 * 6 CE/PI/MA/PA/AM/AC/AP/RR, 7 DF/GO/TO/MT/MS/RO, 8 PR/SC, 9 RS. That is why
 * a genuinely useful table needs no external data.
 */
export const DEFAULT_SHIPPING_TABLE: readonly ShippingTableOption[] = [
  {
    code: 'padrao-sudeste',
    label: 'Entrega padrão',
    prefixes: ['0', '1', '2', '3'],
    estimatedDays: 5,
    carrier: null,
    rates: [
      { upToGrams: 1_000, priceCents: 1_990 },
      { upToGrams: 10_000, priceCents: 2_990 },
      { upToGrams: 30_000, priceCents: 4_990 },
    ],
  },
  {
    code: 'padrao-brasil',
    label: 'Entrega padrão',
    prefixes: ['4', '5', '6', '7', '8', '9'],
    estimatedDays: 10,
    carrier: null,
    rates: [
      { upToGrams: 1_000, priceCents: 2_990 },
      { upToGrams: 10_000, priceCents: 4_490 },
      { upToGrams: 30_000, priceCents: 6_990 },
    ],
  },
];

/**
 * Digits only, or null when it is not a CEP at all.
 *
 * Prefix matching happens on the normalized form so '80000-000' and '80000000'
 * cannot price differently — a hyphen is a formatting choice of whoever typed
 * the address, never a fact about the destination.
 */
export function normalizePostalCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');

  return digits.length === 8 ? digits : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Array.isArray narrows unknown to any[], which lets `any` loose through every
 * element access downstream. This says the same thing while keeping elements
 * unknown, so each one still has to be proven before it is used.
 */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function fail(message: string): never {
  throw new Error(`SHIPPING_TABLE is invalid: ${message}`);
}

function parseRates(raw: unknown, where: string): ShippingRate[] {
  if (!isArray(raw) || raw.length === 0) {
    fail(`${where} must have a non-empty "rates" array`);
  }

  const rates: ShippingRate[] = [];
  // Every bracket must exceed the one before it, and the first must exceed 0 —
  // which the "greater than 0" rule already guarantees, so one counter covers
  // both checks without a special case for the first iteration.
  let previousUpToGrams = 0;

  for (const [index, entry] of raw.entries()) {
    const at = `${where} rate #${String(index + 1)}`;

    if (!isRecord(entry)) {
      fail(`${at} must be an object`);
    }

    if (!isInt(entry.upToGrams) || entry.upToGrams <= 0) {
      fail(`${at} needs an integer "upToGrams" greater than 0`);
    }

    if (!isInt(entry.priceCents) || entry.priceCents < 0) {
      fail(`${at} needs an integer "priceCents" of 0 or more`);
    }

    // Ascending order is not cosmetic: pricing takes the FIRST bracket that
    // covers the parcel, so an out-of-order table would quietly return the
    // wrong bracket's price rather than fail.
    if (entry.upToGrams <= previousUpToGrams) {
      fail(
        `${at} has "upToGrams" ${String(entry.upToGrams)}, which does not come after ` +
          `${String(previousUpToGrams)} — brackets must ascend`,
      );
    }

    previousUpToGrams = entry.upToGrams;
    rates.push({ upToGrams: entry.upToGrams, priceCents: entry.priceCents });
  }

  return rates;
}

function parsePrefixes(raw: unknown, where: string): string[] {
  if (!isArray(raw) || raw.length === 0) {
    fail(`${where} must have a non-empty "prefixes" array`);
  }

  return raw.map((prefix) => {
    if (typeof prefix !== 'string' || !/^\d{1,8}$/.test(prefix)) {
      fail(
        `${where} has the prefix ${JSON.stringify(prefix)} — prefixes must be 1 to 8 digits`,
      );
    }

    return prefix;
  });
}

function parseOption(raw: unknown, index: number): ShippingTableOption {
  const position = `option #${String(index + 1)}`;

  if (!isRecord(raw)) {
    fail(`${position} must be an object`);
  }

  if (!isNonEmptyString(raw.code)) {
    fail(`${position} needs a non-empty "code"`);
  }

  const where = `option "${raw.code}"`;

  if (!isNonEmptyString(raw.label)) {
    fail(`${where} needs a non-empty "label"`);
  }

  if (
    raw.estimatedDays !== undefined &&
    raw.estimatedDays !== null &&
    (!isInt(raw.estimatedDays) || raw.estimatedDays < 0)
  ) {
    fail(
      `${where} needs "estimatedDays" to be a whole number of days, or null`,
    );
  }

  if (
    raw.carrier !== undefined &&
    raw.carrier !== null &&
    typeof raw.carrier !== 'string'
  ) {
    fail(`${where} needs "carrier" to be a string, or null`);
  }

  return {
    code: raw.code,
    label: raw.label,
    prefixes: parsePrefixes(raw.prefixes, where),
    estimatedDays: isInt(raw.estimatedDays) ? raw.estimatedDays : null,
    carrier: typeof raw.carrier === 'string' ? raw.carrier : null,
    rates: parseRates(raw.rates, where),
  };
}

/**
 * Parses and validates the configured table, throwing with a message that
 * names the offending option — a boot failure is only useful if it says which
 * line of JSON to go fix.
 */
export function parseShippingTable(raw: string): ShippingTableOption[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    fail(
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!isArray(parsed) || parsed.length === 0) {
    fail('must be a non-empty JSON array of options');
  }

  const options = parsed.map(parseOption);
  const seen = new Set<string>();

  for (const option of options) {
    // Duplicate codes would make the client's choice ambiguous, and the
    // checkout resolves an order's freight BY code — the wrong one silently
    // winning is a wrong charge.
    if (seen.has(option.code)) {
      fail(`the code "${option.code}" appears more than once`);
    }

    seen.add(option.code);
  }

  return options;
}
