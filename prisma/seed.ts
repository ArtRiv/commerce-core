import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PERMISSIONS } from '../src/auth/authz/permissions';
import { DEFAULT_ROLES } from '../src/auth/authz/role-permissions';
import { PrismaClient } from '../src/generated/prisma/client';
import { schemaFromConnectionString } from '../src/prisma/connection-schema';

/**
 * Writes the permission catalog and the default roles.
 *
 * Exported because the e2e schema needs exactly this and must not have its own
 * copy: reference data that two scripts define separately is reference data
 * that drifts, and a test database seeded differently from production is a
 * test database that lies. `prisma/e2e-schema.ts` calls this against the
 * throwaway schema.
 */
export async function seedAuthz(prisma: PrismaClient): Promise<void> {
  const keys = Object.values(PERMISSIONS);

  await prisma.$transaction(
    [
      ...keys.map((key) =>
        prisma.permission.upsert({
          where: { key },
          create: { key },
          update: {},
        }),
      ),
      prisma.permission.deleteMany({ where: { key: { notIn: keys } } }),
    ],
    { timeout: 20000 },
  );

  for (const role of DEFAULT_ROLES) {
    const permissions = await prisma.permission.findMany({
      where: { key: { in: [...role.permissions] } },
      select: { id: true },
    });

    const permissionLinks = permissions.map((p) => ({ permissionId: p.id }));

    await prisma.role.upsert({
      where: { name: role.name },
      create: {
        name: role.name,
        description: role.description,
        isDefault: role.isDefault,
        permissions: { create: permissionLinks },
      },
      // Re-sync on every seed. `update: {}` meant role-permissions.ts was the
      // source of truth only for brand-new roles — edit a role's permissions
      // and reseed, and nothing happened, because upsert found the row and did
      // nothing. deleteMany clears this role's join rows and create rebuilds
      // them from the catalog, so the file wins every time.
      update: {
        description: role.description,
        isDefault: role.isDefault,
        permissions: { deleteMany: {}, create: permissionLinks },
      },
    });
  }
}

/**
 * Run directly (`prisma db seed`), this seeds DATABASE_URL. Imported, it does
 * nothing until seedAuthz is called — which is what lets the e2e setup reuse
 * it against another connection.
 */
if (require.main === module) {
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const prisma = new PrismaClient({
    // Honours a schema pinned in the URL, so seeding a throwaway schema by
    // hand cannot silently seed production instead.
    adapter: new PrismaPg(
      { connectionString },
      { schema: schemaFromConnectionString(connectionString) },
    ),
  });

  seedAuthz(prisma)
    .catch((err: unknown) => {
      console.error('Seed failed', err);
      process.exit(1);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
