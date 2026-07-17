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

    await prisma.role.upsert({
      where: { name: role.name },
      create: {
        name: role.name,
        description: role.description,
        isDefault: role.isDefault,
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
      update: {},
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
