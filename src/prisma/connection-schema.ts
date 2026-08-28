/**
 * Reads the schema a connection string pins, out of its libqp-style `options`
 * parameter:
 *
 *   postgresql://…/postgres?options=-c%20search_path%3De2e
 *
 * This exists because Postgres name resolution reaches this application by two
 * different routes, and they have to be made to agree. Raw SQL — the TRUNCATEs
 * in the e2e helpers, the `SELECT … FOR UPDATE` in the catalog — resolves
 * unqualified names through the connection's `search_path`. Prisma's generated
 * queries do NOT: with no schema configured the query compiler qualifies
 * everything with `public`, whatever the search_path says.
 *
 * Left alone, that split is silently catastrophic. A test run pinned to a
 * throwaway schema would truncate the empty test tables and then read and write
 * the real ones next door — every assertion passing, against production data.
 *
 * So the schema is derived HERE, from the same string that sets search_path,
 * and handed to the driver adapter. One source of truth means the two layers
 * cannot disagree: either both are in the pinned schema, or the parameter is
 * absent and both are in `public`, which is the normal production case.
 */
export function schemaFromConnectionString(url: string): string | undefined {
  let options: string | null;

  try {
    options = new URL(url).searchParams.get('options');
  } catch {
    // Not a parseable URL. The driver will complain about that far better
    // than a schema helper could.
    return undefined;
  }

  if (!options) {
    return undefined;
  }

  // `-c search_path=a,b` — take the first entry, which is where unqualified
  // CREATEs land and what current_schema() reports.
  const match = /-c\s+search_path\s*=\s*([^\s]+)/.exec(options);
  const schema = match?.[1]?.split(',')[0]?.trim().replace(/^"|"$/g, '');

  // `public` is the default anyway, so returning undefined for it keeps
  // production's generated SQL byte-identical to what it was before this
  // existed.
  return schema && schema !== 'public' ? schema : undefined;
}
