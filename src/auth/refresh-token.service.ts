import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable, UnauthorizedException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RotatedToken {
  userId: string;
  refreshToken: string;
}

/** Any client that can write tokens — the real one or a transaction scope. */
type TokenClient = Prisma.TransactionClient;

/**
 * What the rotation transaction found. A replay is *reported* rather than
 * thrown, so that the family sweep it triggers happens after the transaction
 * commits instead of being rolled back by the throw. See `rotate`.
 */
type RotationOutcome =
  | { kind: 'rotated'; userId: string; refreshToken: string }
  | { kind: 'replayed'; familyId: string }
  | { kind: 'rejected' };

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Issues, rotates and revokes refresh tokens. See docs/specs/auth.md.
 *
 * Tokens are single-use: every refresh consumes one and mints its replacement.
 * Tokens descending from one login share a `familyId`, which is what makes
 * theft recoverable — see `rotate`.
 */
@Injectable()
export class RefreshTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /** Starts a fresh family. One login, one family, one device. */
  issueForNewSession(userId: string): Promise<string> {
    return this.issue(this.prisma, userId, randomUUID());
  }

  /**
   * Exchanges a valid token for its successor in the same family.
   *
   * The interesting case is a token that was *already consumed*. That means two
   * parties hold it: the legitimate client, which rotated past it and moved on,
   * and whoever else got a copy. Nothing in the request distinguishes them, so
   * the entire family is revoked and the real user has to log in again — with a
   * password the thief does not have.
   *
   * Revoking only the replayed token would be worse than doing nothing: if the
   * thief rotated first, their token is a *descendant* of it and stays valid,
   * so we would evict the victim and leave the attacker signed in.
   *
   * The consume-and-reissue pair runs in one transaction: split across
   * statements, two concurrent refreshes could both read `consumedAt: null`
   * before either wrote, and both would walk away with live tokens.
   *
   * The transaction *reports* a replay rather than throwing from inside it, and
   * the revocation happens out here. Prisma rolls an interactive transaction
   * back when its callback throws, so revoking and then throwing in the same
   * callback would undo the revocation on the way out — the theft would be
   * detected, announced with a 401, and then quietly forgiven.
   */
  async rotate(presented: string): Promise<RotatedToken> {
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<RotationOutcome> => {
        const existing = await tx.refreshToken.findUnique({
          where: { tokenHash: hashToken(presented) },
        });

        if (!existing) {
          return { kind: 'rejected' };
        }

        // Checked before expiry/revocation: a consumed token is a theft signal
        // whether or not it was later revoked, and must still trigger a sweep.
        if (existing.consumedAt) {
          return { kind: 'replayed', familyId: existing.familyId };
        }

        if (existing.revokedAt || existing.expiresAt.getTime() <= Date.now()) {
          return { kind: 'rejected' };
        }

        await tx.refreshToken.update({
          where: { id: existing.id },
          data: { consumedAt: new Date() },
        });

        return {
          kind: 'rotated',
          userId: existing.userId,
          refreshToken: await this.issue(
            tx,
            existing.userId,
            existing.familyId,
          ),
        };
      },
    );

    if (outcome.kind === 'replayed') {
      await this.revokeFamily(this.prisma, outcome.familyId);
      throw new UnauthorizedException();
    }

    if (outcome.kind === 'rejected') {
      throw new UnauthorizedException();
    }

    return { userId: outcome.userId, refreshToken: outcome.refreshToken };
  }

  /**
   * Logout: kills the session the token belongs to, and only that one.
   *
   * Silent when the token is unknown or someone else's. Logging out twice is
   * not an error worth reporting, and a distinct response would confirm to a
   * caller whether a given token exists.
   */
  async revokeSession(userId: string, presented: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });

    if (!existing || existing.userId !== userId) {
      return;
    }

    await this.revokeFamily(this.prisma, existing.familyId);
  }

  /** Every session, everywhere. For password reset (phase 2). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issue(
    client: TokenClient,
    userId: string,
    familyId: string,
  ): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await client.refreshToken.create({
      data: {
        tokenHash: hashToken(token),
        familyId,
        userId,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    return token;
  }

  /**
   * Scoped by family, never by user: a theft on one device must not sign the
   * user out of the others.
   */
  private async revokeFamily(
    client: TokenClient,
    familyId: string,
  ): Promise<void> {
    await client.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
