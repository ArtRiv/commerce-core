import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL not set in environment.');
    process.exit(1);
  }

  console.log('Connecting to PostgreSQL database...');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  console.log('Querying applied migrations from _prisma_migrations...');
  const appliedRes = await client.query(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL'
  );
  const appliedSet = new Set(appliedRes.rows.map((r) => r.migration_name));

  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');
  const entries = readdirSync(migrationsDir).sort();

  const pending = entries.filter((name) => {
    const fullPath = join(migrationsDir, name);
    return statSync(fullPath).isDirectory() && !appliedSet.has(name);
  });

  if (pending.length === 0) {
    console.log('No pending migrations. Database schema is already up to date!');
    await client.end();
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):`, pending);

  for (const migrationName of pending) {
    const sqlPath = join(migrationsDir, migrationName, 'migration.sql');
    const sqlContent = readFileSync(sqlPath, 'utf8');
    const checksum = createHash('sha256').update(sqlContent).digest('hex');

    console.log(`Applying migration: ${migrationName}...`);
    const startedAt = new Date();

    await client.query('BEGIN');
    try {
      await client.query(sqlContent);

      const finishedAt = new Date();
      await client.query(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5, 1)`,
        [randomUUID(), checksum, finishedAt, migrationName, startedAt]
      );

      await client.query('COMMIT');
      console.log(`✔ Successfully applied and recorded: ${migrationName}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✖ Failed to apply migration: ${migrationName}`, err);
      await client.end();
      process.exit(1);
    }
  }

  console.log('All pending migrations successfully deployed!');
  await client.end();
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
