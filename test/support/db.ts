import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Clears the tables the auth tests own, between tests.
 *
 * `users` only — refresh_tokens and verification_tokens follow via CASCADE.
 * Roles and permissions are deliberately left alone: they are seeded reference
 * data, not test fixtures, and registration reads the is_default role out of
 * them. Truncating those would break registration in a way that looks like an
 * application bug.
 */
export async function resetAuthTables(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
}

interface VerifiedUserInput {
  email: string;
  /** Null models an account created through Google, which never set one. */
  passwordHash: string | null;
}

/**
 * Creates an account that has already cleared email verification.
 *
 * Phase 1 has no way to verify an address through the API — that arrives with
 * the Resend integration — so tests set emailVerifiedAt directly. This is the
 * one seam where tests reach past the API; everything else goes over HTTP.
 */
export async function createVerifiedUser(
  prisma: PrismaService,
  { email, passwordHash }: VerifiedUserInput,
): Promise<{ id: string }> {
  const role = await prisma.role.findFirstOrThrow({
    where: { isDefault: true },
    select: { id: true },
  });

  return prisma.user.create({
    data: {
      email,
      name: 'Test User',
      passwordHash,
      roleId: role.id,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
}
