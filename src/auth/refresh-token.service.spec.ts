import { createHash } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface StoredToken {
  id: string;
  tokenHash: string;
  familyId: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
}

function storedToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    id: 'token-1',
    tokenHash: sha256('presented-token'),
    familyId: 'family-1',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

// Argument shapes the service is expected to call Prisma with. Spelled out so
// the assertions below read the real call arguments as typed values instead of
// casting `any` at every access.
interface FindUniqueArgs {
  where: { tokenHash: string };
}

interface CreateArgs {
  data: {
    tokenHash: string;
    familyId: string;
    userId: string;
    expiresAt: Date;
  };
}

interface UpdateArgs {
  where: { id: string };
  data: { consumedAt: Date };
}

interface UpdateManyArgs {
  where: { familyId?: string; userId?: string; revokedAt: null };
  data: { revokedAt: Date };
}

function createPrismaMock() {
  const refreshToken = {
    findUnique: jest.fn<Promise<StoredToken | null>, [FindUniqueArgs]>(),
    create: jest.fn<Promise<unknown>, [CreateArgs]>().mockResolvedValue({}),
    update: jest.fn<Promise<unknown>, [UpdateArgs]>().mockResolvedValue({}),
    updateMany: jest
      .fn<Promise<unknown>, [UpdateManyArgs]>()
      .mockResolvedValue({ count: 0 }),
  };

  const client: {
    refreshToken: typeof refreshToken;
    $transaction: jest.Mock;
  } = {
    refreshToken,
    $transaction: jest.fn(),
  };

  // The real $transaction hands the callback a scoped client. Passing the same
  // mock straight through keeps assertions simple; that this genuinely runs in
  // one transaction is proven by the e2e replay test, not here.
  // Assigned after construction because the implementation closes over `client`
  // itself, which it cannot do from inside its own initializer.
  client.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(client),
  );

  return client;
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith(prisma: PrismaMock): RefreshTokenService {
  return new RefreshTokenService(prisma as unknown as PrismaService);
}

describe('RefreshTokenService', () => {
  describe('issueForNewSession', () => {
    it('stores only a hash, never the token itself', async () => {
      const prisma = createPrismaMock();
      const token = await serviceWith(prisma).issueForNewSession('user-1');
      const [{ data }] = prisma.refreshToken.create.mock.calls[0];

      expect(data.tokenHash).toBe(sha256(token));
      expect(JSON.stringify(data)).not.toContain(token);
    });

    it('returns a token with real entropy', async () => {
      const prisma = createPrismaMock();
      const service = serviceWith(prisma);

      const first = await service.issueForNewSession('user-1');
      const second = await service.issueForNewSession('user-1');

      expect(first).not.toBe(second);
      expect(first.length).toBeGreaterThanOrEqual(32);
    });

    it('starts a new family per login, so sessions stay independent', async () => {
      const prisma = createPrismaMock();
      const service = serviceWith(prisma);

      await service.issueForNewSession('user-1');
      await service.issueForNewSession('user-1');

      const [[first], [second]] = prisma.refreshToken.create.mock.calls;

      expect(first.data.familyId).not.toBe(second.data.familyId);
    });

    it('expires the token 7 days out', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).issueForNewSession('user-1');

      const [{ data }] = prisma.refreshToken.create.mock.calls[0];
      const days = (data.expiresAt.getTime() - Date.now()) / 86_400_000;

      expect(days).toBeCloseTo(7, 1);
    });
  });

  describe('rotate', () => {
    it('looks the token up by hash, not by its plaintext', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken());

      await serviceWith(prisma).rotate('presented-token');

      const [args] = prisma.refreshToken.findUnique.mock.calls[0];
      expect(args.where.tokenHash).toBe(sha256('presented-token'));
    });

    it('consumes the presented token and replaces it within the same family', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken());

      const result = await serviceWith(prisma).rotate('presented-token');

      const [consumed] = prisma.refreshToken.update.mock.calls[0];
      expect(consumed.where.id).toBe('token-1');
      expect(consumed.data.consumedAt).toBeInstanceOf(Date);

      const [{ data }] = prisma.refreshToken.create.mock.calls[0];
      expect(data.familyId).toBe('family-1');
      expect(data.tokenHash).toBe(sha256(result.refreshToken));
      expect(result.userId).toBe('user-1');
    });

    it('rejects a token that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(serviceWith(prisma).rotate('nope')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        serviceWith(prisma).rotate('presented-token'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a revoked token without treating it as theft', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ revokedAt: new Date() }),
      );

      await expect(
        serviceWith(prisma).rotate('presented-token'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    // The heart of the design. A token that was already spent coming back means
    // two parties hold it: the legitimate client (which rotated past it) and
    // whoever stole it. There is no way to tell which one is presenting it now,
    // so the whole family dies and the real user reauthenticates with a
    // password the thief does not have. Revoking only this token would be worse
    // than useless — the thief's replacement token is a *descendant*, still
    // valid, so we would log out the victim and leave the attacker in.
    it('revokes the entire family when a consumed token is replayed', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ consumedAt: new Date(Date.now() - 5000) }),
      );

      await expect(
        serviceWith(prisma).rotate('presented-token'),
      ).rejects.toThrow(UnauthorizedException);

      const [revoke] = prisma.refreshToken.updateMany.mock.calls[0];
      expect(revoke.where.familyId).toBe('family-1');
      expect(revoke.data.revokedAt).toBeInstanceOf(Date);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('leaves other families alone when revoking for theft', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ consumedAt: new Date() }),
      );

      await expect(
        serviceWith(prisma).rotate('presented-token'),
      ).rejects.toThrow(UnauthorizedException);

      // Scoped by family, never by userId: a theft on one device must not sign
      // the user out of their others.
      const [revoke] = prisma.refreshToken.updateMany.mock.calls[0];
      expect(revoke.where).not.toHaveProperty('userId');
    });
  });

  describe('revokeSession', () => {
    it('revokes the family the presented token belongs to', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken());

      await serviceWith(prisma).revokeSession('user-1', 'presented-token');

      const [revoke] = prisma.refreshToken.updateMany.mock.calls[0];
      expect(revoke.where.familyId).toBe('family-1');
    });

    it('ignores a token belonging to a different user', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedToken({ userId: 'someone-else' }),
      );

      await serviceWith(prisma).revokeSession('user-1', 'presented-token');

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('is idempotent for an unknown token', async () => {
      const prisma = createPrismaMock();
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      // Logging out twice, or with a stale token, is not an error worth
      // reporting — and a distinct error would confirm whether a token exists.
      await expect(
        serviceWith(prisma).revokeSession('user-1', 'nope'),
      ).resolves.toBeUndefined();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeAllSessions', () => {
    it('revokes every live family of the user', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).revokeAllSessions('user-1');

      const [revoke] = prisma.refreshToken.updateMany.mock.calls[0];
      expect(revoke.where.userId).toBe('user-1');
      expect(revoke.where.revokedAt).toBeNull();
      expect(revoke.data.revokedAt).toBeInstanceOf(Date);
    });
  });
});
