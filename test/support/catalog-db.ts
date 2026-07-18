import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Clears the tables the catalog tests own, between tests.
 *
 * products and categories only — product_categories follows via CASCADE.
 * Users are deliberately NOT cleared here: the catalog suite creates its
 * fixture users (one per role) once in beforeAll and reuses their tokens
 * across tests, so wiping users per-test would invalidate every token.
 */
export async function resetCatalogTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "products", "categories" CASCADE',
  );
}

interface RoleUserInput {
  email: string;
  passwordHash: string;
  /** Seeded role name: 'customer' | 'operator' | 'admin'. */
  roleName: string;
}

/**
 * Creates a verified account holding a specific seeded role.
 *
 * Same seam as createVerifiedUser in db.ts, one step wider: the API has no
 * endpoint to assign roles (that is deliberate — roles are granted by
 * administrative action, not self-service), so tests that need an operator
 * or an admin write the role directly. Everything after this point — login,
 * permissions resolution, the 403s — goes over HTTP.
 */
export async function createUserWithRole(
  prisma: PrismaService,
  { email, passwordHash, roleName }: RoleUserInput,
): Promise<{ id: string }> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: roleName },
    select: { id: true },
  });

  return prisma.user.create({
    data: {
      email,
      name: `Catalog ${roleName}`,
      passwordHash,
      roleId: role.id,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
}
