import { schemaFromConnectionString } from './connection-schema';

const BASE = 'postgresql://user:pass@host:6543/postgres';

/**
 * The function that decides which schema Prisma's generated SQL targets.
 *
 * Getting it wrong in one direction breaks the e2e isolation invisibly — the
 * suite truncates a throwaway schema while reading and writing the real one.
 * Getting it wrong in the other changes production's SQL. Both are worth
 * pinning down.
 */
describe('schemaFromConnectionString', () => {
  it('returns nothing for a plain production URL', () => {
    expect(schemaFromConnectionString(BASE)).toBeUndefined();
    expect(
      schemaFromConnectionString(`${BASE}?pgbouncer=true&sslmode=require`),
    ).toBeUndefined();
  });

  it('reads the schema out of a percent-encoded options parameter', () => {
    // What .env.example documents, and what URL parsing hands back decoded.
    expect(
      schemaFromConnectionString(
        `${BASE}?pgbouncer=true&options=-c%20search_path%3De2e`,
      ),
    ).toBe('e2e');
  });

  it('takes the first entry when the path lists several', () => {
    // Unqualified CREATEs land in the first schema, and current_schema()
    // reports it — so that is the one Prisma has to agree with.
    expect(
      schemaFromConnectionString(
        `${BASE}?options=-c%20search_path%3De2e,extensions`,
      ),
    ).toBe('e2e');
  });

  it('treats an explicit public as no schema at all', () => {
    // Not a special case for its own sake: it keeps production's generated SQL
    // byte-identical whether or not somebody spells the default out.
    expect(
      schemaFromConnectionString(`${BASE}?options=-c%20search_path%3Dpublic`),
    ).toBeUndefined();
  });

  it('survives an options parameter it does not understand', () => {
    expect(
      schemaFromConnectionString(`${BASE}?options=-c%20statement_timeout%3D5s`),
    ).toBeUndefined();
    expect(schemaFromConnectionString('not-a-url-at-all')).toBeUndefined();
  });
});
