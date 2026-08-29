/**
 * The zone weeks and months are cut in (docs/specs/reports.md, invariant 4).
 *
 * Cutting a Brazilian store's weeks in UTC puts every Sunday evening's sales
 * into the following Monday — three hours of every Sunday, in the wrong week,
 * forever. So the boundary is configuration, which is exactly where the reuse
 * model says a difference between stores belongs.
 */

/** What an instance that never configured one gets. */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Reads REPORTS_TIMEZONE, defaulting to UTC, and refuses a zone that is not
 * real.
 *
 * Validated with Intl rather than by asking Postgres: it is synchronous and
 * needs no connection, so it can run in a constructor and take the boot down
 * naming the bad value. The alternative — discovering it when the first report
 * is requested — turns a typo in an .env into a 500 on a route that worked
 * yesterday.
 *
 * The value is never concatenated into SQL. It goes in as a bound parameter,
 * so this check is about correctness, not about injection.
 */
export function resolveTimeZone(raw: string | undefined): string {
  const zone = raw?.trim();

  if (!zone) {
    return DEFAULT_TIME_ZONE;
  }

  try {
    // Throws RangeError on anything the platform's tz database does not know.
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format();
  } catch {
    throw new Error(
      `REPORTS_TIMEZONE is not a valid IANA time zone: "${zone}". Use something like "America/Sao_Paulo", or leave it blank for ${DEFAULT_TIME_ZONE}.`,
    );
  }

  return zone;
}
