import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { VerificationTokenPurpose } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_BYTES = 32;

/**
 * A reset link is a live takeover of an account that already exists, so it gets
 * an hour. A verification link only activates an account nobody has used yet,
 * and has to survive someone getting to their inbox tomorrow.
 */
const TTL_MS: Record<VerificationTokenPurpose, number> = {
  [VerificationTokenPurpose.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000,
  [VerificationTokenPurpose.PASSWORD_RESET]: 60 * 60 * 1000,
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Single-use, expiring tokens mailed to a user to prove they read an address.
 * Backs both email verification and password reset — see
 * prisma/models/verification-token.prisma on why one model serves both.
 */
@Injectable()
export class VerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Issues a token, retiring any the user still had for the same purpose.
   *
   * That retirement is the point: without it, every "resend" adds another
   * working key, so a mailbox with five reset links is five live chances at the
   * account — and revoking the newest would leave the older ones standing. Only
   * the most recent link works.
   *
   * Scoped to one purpose, so resending a reset link does not silently cancel a
   * pending email verification.
   */
  async issue(
    userId: string,
    purpose: VerificationTokenPurpose,
  ): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.prisma.$transaction(async (tx) => {
      await tx.verificationToken.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await tx.verificationToken.create({
        data: {
          tokenHash: hashToken(token),
          purpose,
          userId,
          expiresAt: new Date(Date.now() + TTL_MS[purpose]),
        },
      });
    });

    return token;
  }

  /**
   * Spends a token and returns whose it was.
   *
   * `purpose` is not decoration. Both kinds live in one table under one lookup,
   * so without this check they are interchangeable — and a verification token,
   * which anyone can mint by typing an address into /auth/register and which
   * lasts a day, would reset that account's password. The two flows must never
   * accept each other's tokens.
   *
   * Every failure is the same BadRequestException. A caller holding a bad token
   * learns nothing about why: whether it expired, was already used, or was
   * meant for something else is not information they are owed.
   */
  async consume(
    presented: string,
    purpose: VerificationTokenPurpose,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.verificationToken.findUnique({
        where: { tokenHash: hashToken(presented) },
      });

      if (
        !existing ||
        existing.purpose !== purpose ||
        existing.consumedAt ||
        existing.expiresAt.getTime() <= Date.now()
      ) {
        throw new BadRequestException('Invalid or expired token');
      }

      await tx.verificationToken.update({
        where: { id: existing.id },
        data: { consumedAt: new Date() },
      });

      return existing.userId;
    });
  }
}
