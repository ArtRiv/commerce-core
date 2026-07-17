import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PERMISSIONS } from '../src/auth/authz/permissions';
import { DEFAULT_ROLES } from '../src/auth/authz/role-permissions';
import { PrismaClient } from '../src/generated/prisma/client';

const connectionString = process.env['DATABASE_URL'];

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
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

main()
  .catch((err: unknown) => {
    console.error('Seed failed', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
