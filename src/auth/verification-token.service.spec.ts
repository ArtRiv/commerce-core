import { createHash } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';

import { VerificationTokenPurpose } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { VerificationTokenService } from './verification-token.service';

const { EMAIL_VERIFICATION, PASSWORD_RESET } = VerificationTokenPurpose;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface StoredToken {
  id: string;
  tokenHash: string;
  purpose: VerificationTokenPurpose;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

function storedToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    id: 'token-1',
    tokenHash: sha256('presented-token'),
    purpose: EMAIL_VERIFICATION,
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  };
}

interface FindUniqueArgs {
  where: { tokenHash: string };
}

interface CreateArgs {
  data: {
    tokenHash: string;
    purpose: VerificationTokenPurpose;
    userId: string;
    expiresAt: Date;
  };
}

interface UpdateArgs {
  where: { id: string };
  data: { consumedAt: Date };
}

interface UpdateManyArgs {
  where: {
    userId: string;
    purpose: VerificationTokenPurpose;
    consumedAt: null;
  };
  data: { consumedAt: Date };
}

function createTokenTable() {
  return {
    findUnique: jest.fn<Promise<StoredToken | null>, [FindUniqueArgs]>(),
    create: jest.fn<Promise<unknown>, [CreateArgs]>().mockResolvedValue({}),
    update: jest.fn<Promise<unknown>, [UpdateArgs]>().mockResolvedValue({}),
    updateMany: jest
      .fn<Promise<unknown>, [UpdateManyArgs]>()
      .mockResolvedValue({ count: 0 }),
  };
}

// Transaction scope kept separate from the client, for the reason spelled out
// in refresh-token.service.spec.ts: a shared mock cannot express a rollback.
function createPrismaMock() {
  const tx = { verificationToken: createTokenTable() };

  const client: {
    verificationToken: ReturnType<typeof createTokenTable>;
    $transaction: jest.Mock;
  } = {
    verificationToken: createTokenTable(),
    $transaction: jest.fn(),
  };

  client.$transaction.mockImplementation((cb: (scope: typeof tx) => unknown) =>
    cb(tx),
  );

  return { client, tx };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith({ client }: PrismaMock): VerificationTokenService {
  return new VerificationTokenService(client as unknown as PrismaService);
}

describe('VerificationTokenService', () => {
  describe('issue', () => {
    it('stores only a hash, never the token itself', async () => {
      const prisma = createPrismaMock();
      const token = await serviceWith(prisma).issue(
        'user-1',
        EMAIL_VERIFICATION,
      );
      const [{ data }] = prisma.tx.verificationToken.create.mock.calls[0];

      expect(data.tokenHash).toBe(sha256(token));
      expect(JSON.stringify(data)).not.toContain(token);
    });

    it('returns a token with real entropy', async () => {
      const prisma = createPrismaMock();
      const service = serviceWith(prisma);

      const first = await service.issue('user-1', EMAIL_VERIFICATION);
      const second = await service.issue('user-1', EMAIL_VERIFICATION);

      expect(first).not.toBe(second);
      expect(first.length).toBeGreaterThanOrEqual(32);
    });

    it('gives a verification token 24 hours', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).issue('user-1', EMAIL_VERIFICATION);

      const [{ data }] = prisma.tx.verificationToken.create.mock.calls[0];
      const hours = (data.expiresAt.getTime() - Date.now()) / 3_600_000;

      expect(hours).toBeCloseTo(24, 1);
    });

    it('gives a reset token only 1 hour', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).issue('user-1', PASSWORD_RESET);

      const [{ data }] = prisma.tx.verificationToken.create.mock.calls[0];
      const hours = (data.expiresAt.getTime() - Date.now()) / 3_600_000;

      // Shorter than verification on purpose: a reset link is a live takeover
      // of an account that already exists.
      expect(hours).toBeCloseTo(1, 1);
    });

    it('invalidates the user’s outstanding tokens of that purpose', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).issue('user-1', PASSWORD_RESET);

      // Asking for a new link retires the old one, so a mailbox full of reset
      // links does not mean a stack of usable keys — only the newest works.
      const [invalidate] = prisma.tx.verificationToken.updateMany.mock.calls[0];
      expect(invalidate.where).toEqual({
        userId: 'user-1',
        purpose: PASSWORD_RESET,
        consumedAt: null,
      });
    });

    it('leaves the other purpose’s tokens alone', async () => {
      const prisma = createPrismaMock();
      await serviceWith(prisma).issue('user-1', PASSWORD_RESET);

      // Resending a reset link must not quietly cancel a pending email
      // verification: unrelated flows.
      const [invalidate] = prisma.tx.verificationToken.updateMany.mock.calls[0];
      expect(invalidate.where.purpose).toBe(PASSWORD_RESET);
    });
  });

  describe('consume', () => {
    it('returns the owner and spends the token', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(storedToken());

      const userId = await serviceWith(prisma).consume(
        'presented-token',
        EMAIL_VERIFICATION,
      );

      expect(userId).toBe('user-1');
      const [spent] = prisma.tx.verificationToken.update.mock.calls[0];
      expect(spent.where.id).toBe('token-1');
      expect(spent.data.consumedAt).toBeInstanceOf(Date);
    });

    it('looks the token up by hash, not by its plaintext', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(storedToken());

      await serviceWith(prisma).consume('presented-token', EMAIL_VERIFICATION);

      const [args] = prisma.tx.verificationToken.findUnique.mock.calls[0];
      expect(args.where.tokenHash).toBe(sha256('presented-token'));
    });

    // The one that matters most here. Without this check, the two purposes are
    // interchangeable: a verification token — handed out to anyone who types an
    // email into /auth/register, and valid for 24h — would also reset that
    // account's password. Same column, same lookup; only the purpose says no.
    it('refuses a token issued for a different purpose', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(
        storedToken({ purpose: EMAIL_VERIFICATION }),
      );

      await expect(
        serviceWith(prisma).consume('presented-token', PASSWORD_RESET),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.tx.verificationToken.update).not.toHaveBeenCalled();
    });

    it('rejects a token that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).consume('nope', EMAIL_VERIFICATION),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an expired token', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(
        storedToken({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        serviceWith(prisma).consume('presented-token', EMAIL_VERIFICATION),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.tx.verificationToken.update).not.toHaveBeenCalled();
    });

    it('rejects a token that was already spent', async () => {
      const prisma = createPrismaMock();
      prisma.tx.verificationToken.findUnique.mockResolvedValue(
        storedToken({ consumedAt: new Date() }),
      );

      await expect(
        serviceWith(prisma).consume('presented-token', EMAIL_VERIFICATION),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.tx.verificationToken.update).not.toHaveBeenCalled();
    });
  });
});
