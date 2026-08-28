import 'dotenv/config';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';

import { PrismaClient } from '../src/generated/prisma/client';
import { seedAuthz } from './seed';

/**
 * Builds the throwaway schema the e2e suite runs against.
 *
 * The suite TRUNCATEs the tables it touches, so it must never be pointed at a
 * database holding data anyone cares about — and this project has only two
 * Supabase projects, both real. The answer is a dedicated SCHEMA inside the
 * development project: `e2e` is created from the same migrations production
 * runs, wiped and rebuilt by this script, and completely separate from
 * `public` next door.
 *
 * Isolation rides on the connection's `search_path`, pinned through the
 * libpq-style `options` parameter in E2E_DATABASE_URL:
 *
 *   ?options=-c%20search_path%3De2e
 *
 * That matters more than it looks. Prisma's model queries and the raw SQL in
 * the test helpers (`TRUNCATE TABLE "products"`) resolve table names by two
 * different routes, and a scheme that only redirected one of them would let
 * the suite read the test schema while truncating the real one. search_path
 * moves both, because it moves name resolution itself. It is pinned at
 * connection startup rather than by a `SET`, which a transaction pooler would
 * forget between statements.
 *
 * `public` is never in that path. An unqualified name for a table missing from
 * the test schema fails loudly instead of quietly finding the real one.
 */

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Reads the target schema out of the URL, and refuses anything dangerous. */
function resolveSchema(url: string): string {
  const options = new URL(url).searchParams.get('options') ?? '';
  const match = /-c\s+search_path=([^\s]+)/.exec(options);
  const schema = match?.[1]?.split(',')[0]?.trim();

  if (!schema) {
    throw new Error(
      'E2E_DATABASE_URL must pin a schema: append ?options=-c%20search_path%3De2e',
    );
  }

  // The whole point. A test database URL that resolves to public is the
  // accident this script exists to make impossible.
  if (schema === 'public') {
    throw new Error('Refusing to build the e2e schema in "public"');
  }

  return schema;
}

/** Timestamp-prefixed, so lexicographic order is chronological order. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function main(): Promise<void> {
  const url = process.env['E2E_DATABASE_URL'];

  if (!url) {
    throw new Error('E2E_DATABASE_URL is not set — see docs/workflow.md');
  }

  if (url === process.env['DATABASE_URL']) {
    throw new Error(
      'E2E_DATABASE_URL is identical to DATABASE_URL — that is the development database, not a test schema',
    );
  }

  const schema = resolveSchema(url);
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // Belt and braces: ask the server where it actually landed rather than
    // trusting the string we parsed.
    const { rows } = await client.query<{ schema: string | null }>(
      'SELECT current_schema() AS schema',
    );

    // Null when the schema does not exist yet, which is the normal first run.
    const current = rows[0]?.schema ?? null;

    if (current !== null && current !== schema) {
      throw new Error(
        `Connected to schema "${current}" but expected "${schema}" — the options parameter did not take`,
      );
    }

    console.log(`Rebuilding schema "${schema}"…`);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.query(`CREATE SCHEMA "${schema}"`);

    // The real migrations, in order, exactly as `migrate deploy` would run
    // them — so the test schema cannot drift into a shape production never
    // had. Each file goes over as one multi-statement query, which Postgres
    // wraps in an implicit transaction: a file that fails leaves nothing
    // behind.
    for (const name of migrationFiles()) {
      const sql = readFileSync(
        join(MIGRATIONS_DIR, name, 'migration.sql'),
        'utf8',
      );
      await client.query(sql);
      console.log(`  applied ${name}`);
    }
  } finally {
    await client.end();
  }

  // Through Prisma, on the same pinned connection — which also proves the
  // client resolves names by search_path rather than reaching for a hardcoded
  // "public". If that were not true, this would seed the wrong schema, and
  // every table it just built would still be empty.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }, { schema }),
  });

  try {
    await seedAuthz(prisma);

    // Counted through a SECOND connection, schema-qualified by hand, because
    // counting through the same client that just wrote proves nothing: if the
    // client were resolving to `public`, it would read back the development
    // database's own roles and report success. This asks the question in a way
    // that can only be answered by the schema we meant.
    const audit = new Client({ connectionString: url });
    await audit.connect();
    const { rows } = await audit.query<{ roles: number; permissions: number }>(
      `SELECT (SELECT count(*)::int FROM "${schema}"."roles")       AS roles,
              (SELECT count(*)::int FROM "${schema}"."permissions") AS permissions`,
    );
    await audit.end();

    const roles = rows[0]?.roles ?? 0;
    const permissions = rows[0]?.permissions ?? 0;

    if (roles === 0 || permissions === 0) {
      throw new Error(
        `Seed reported success but "${schema}" is empty — the client wrote somewhere else`,
      );
    }

    console.log(
      `Schema "${schema}" is ready: ${String(roles)} roles, ${String(permissions)} permissions.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'Failed to build the e2e schema:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
