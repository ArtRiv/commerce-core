/**
 * Reading the two things a raw aggregate hands back, and refusing everything
 * else.
 *
 * Both exist for the same reason: this module is the only place in the API
 * that reads values Prisma did not type for it, so the conversion from "what
 * the driver returned" to "a number/date this API promises" is written down
 * once and tested, rather than sprinkled as `Number(...)` at six call sites.
 *
 * See docs/specs/reports.md, invariant 7.
 */

/**
 * A SUM or COUNT, as a JavaScript number.
 *
 * Every aggregate in this module is cast to `::bigint` in SQL, because SUM
 * over `int` is bigint in Postgres and a store's lifetime revenue in cents
 * outgrows int4 at around twenty-one million reais. Depending on the path it
 * takes, that arrives here as a BigInt or as a string.
 *
 * The MAX_SAFE_INTEGER check is the point of the function. Money is integer
 * cents and must never arrive silently rounded; 2^53 cents is ninety trillion
 * reais, so crossing it means something upstream is wrong, not that the store
 * had a good year.
 */
export function toCount(value: unknown): number {
  // A SUM over no rows is null. Zero is its only sensible reading, and the
  // queries COALESCE anyway — this is the second belt, not the first.
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === 'bigint') {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new Error(
        `Aggregate ${value.toString()} is too large to represent exactly`,
      );
    }

    return Number(value);
  }

  const parsed = typeof value === 'string' ? Number(value) : value;

  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new Error(
      `Aggregate is not an exact integer: ${JSON.stringify(value)}`,
    );
  }

  return parsed;
}

/**
 * A timestamp the queries formatted as explicit UTC text, or null.
 *
 * The text detour is deliberate. node-postgres parses a `timestamp without
 * time zone` into a Date through the *process's* offset, so a column holding
 * a UTC reading comes back shifted by however the server happens to be
 * configured — a bug that is invisible on a machine running in UTC and wrong
 * everywhere else. Formatting it in SQL and parsing it here means the only
 * offset involved is the one written into the string.
 */
export function toInstant(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  // Narrowed rather than coerced: these columns come back as the text the
  // query formatted, and anything else means the SELECT changed shape.
  if (typeof value !== 'string') {
    throw new Error(
      `Not a timestamp this module wrote: ${JSON.stringify(value)}`,
    );
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Not a timestamp this module wrote: ${value}`);
  }

  return parsed;
}
