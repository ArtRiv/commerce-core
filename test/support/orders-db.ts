import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Clears the tables the orders tests own, between tests.
 *
 * carts and orders only — cart_items and order_items follow via CASCADE
 * (TRUNCATE CASCADE reaches referencing tables). Runs before
 * resetCatalogTables on purpose: order_items Restricts product deletion, so
 * order rows must go before the products they point at. Users are left
 * alone for the same reason as the catalog suite: fixture users are created
 * once in beforeAll and their tokens must survive every test.
 */
export async function resetOrdersTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "orders", "carts" CASCADE');
}
