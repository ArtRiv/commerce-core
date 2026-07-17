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
   * All of it runs in one transaction. Split across statements, two concurrent
   * replays could both read `consumedAt: null` before either wrote, and both
   * would be issued live tokens.
   */
  rotate(presented: string): Promise<RotatedToken> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.refreshToken.findUnique({
        where: { tokenHash: hashToken(presented) },
      });

      if (!existing) {
        throw new UnauthorizedException();
      }

      if (existing.consumedAt) {
        await this.revokeFamily(tx, existing.familyId);
        throw new UnauthorizedException();
      }

      // Checked after the replay case on purpose: a consumed token is a theft
      // signal whether or not it was later revoked, and it should still trigger
      // the sweep.
      if (existing.revokedAt || existing.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedException();
      }

      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { consumedAt: new Date() },
      });

      return {
        userId: existing.userId,
        refreshToken: await this.issue(tx, existing.userId, existing.familyId),
      };
    });
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
