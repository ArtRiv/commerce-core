import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';

import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { RefreshTokenService } from './refresh-token.service';

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
}

interface UserFindArgs {
  where: { email: string };
  select?: Record<string, boolean>;
}

interface UserCreateArgs {
  data: {
    email: string;
    name: string;
    passwordHash: string;
    roleId: string;
  };
}

interface RoleFindArgs {
  where: { isDefault: boolean };
}

function createMocks() {
  const prisma = {
    user: {
      findUnique: jest.fn<Promise<StoredUser | null>, [UserFindArgs]>(),
      create: jest
        .fn<Promise<{ id: string; email: string }>, [UserCreateArgs]>()
        .mockResolvedValue({ id: 'user-1', email: 'ada@example.com' }),
    },
    role: {
      findFirst: jest
        .fn<Promise<{ id: string } | null>, [RoleFindArgs]>()
        .mockResolvedValue({ id: 'role-customer' }),
    },
  };

  const passwords = {
    hash: jest.fn<Promise<string>, [string]>().mockResolvedValue('$argon2id$…'),
    verify: jest.fn<Promise<boolean>, [string | null, string]>(),
  };

  const refreshTokens = {
    issueForNewSession: jest
      .fn<Promise<string>, [string]>()
      .mockResolvedValue('refresh-token'),
    rotate: jest.fn<
      Promise<{ userId: string; refreshToken: string }>,
      [string]
    >(),
    revokeSession: jest
      .fn<Promise<void>, [string, string]>()
      .mockResolvedValue(undefined),
    revokeAllSessions: jest.fn<Promise<void>, [string]>(),
  };

  const jwt = {
    signAsync: jest
      .fn<Promise<string>, [Record<string, unknown>]>()
      .mockResolvedValue('access-token'),
  };

  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords as unknown as PasswordService,
    refreshTokens as unknown as RefreshTokenService,
    jwt as unknown as JwtService,
  );

  return { service, prisma, passwords, refreshTokens, jwt };
}

const registerDto = {
  email: 'ada@example.com',
  password: 'correct horse battery staple',
  name: 'Ada',
};

describe('AuthService', () => {
  describe('register', () => {
    it('creates the account unverified, with the default role', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.register(registerDto);

      const [{ data }] = prisma.user.create.mock.calls[0];
      expect(data.roleId).toBe('role-customer');
      // emailVerifiedAt is never set on the way in; the column defaults to
      // null. Registration proves nothing about owning the address.
      expect(data).not.toHaveProperty('emailVerifiedAt');
    });

    it('asks for the default role rather than hardcoding a name', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.register(registerDto);

      // Which role new users get is the DB's call (roles.is_default), not a
      // string literal in the service. Spelling 'customer' here would silently
      // break the day a deployment renames it.
      const [args] = prisma.role.findFirst.mock.calls[0];
      expect(args.where.isDefault).toBe(true);
    });

    it('stores a hash, never the password', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.register(registerDto);

      expect(passwords.hash).toHaveBeenCalledWith(registerDto.password);
      const [{ data }] = prisma.user.create.mock.calls[0];
      expect(data.passwordHash).toBe('$argon2id$…');
      expect(JSON.stringify(data)).not.toContain(registerDto.password);
    });

    it('lowercases the email so one address cannot become two accounts', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.register({ ...registerDto, email: 'Ada@Example.COM' });

      const [{ data }] = prisma.user.create.mock.calls[0];
      expect(data.email).toBe('ada@example.com');

      const [lookup] = prisma.user.findUnique.mock.calls[0];
      expect(lookup.where.email).toBe('ada@example.com');
    });

    it('rejects an email already registered and verified', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'ada@example.com',
        passwordHash: '$argon2id$…',
        emailVerifiedAt: new Date(),
      });

      await expect(service.register(registerDto)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('does not duplicate an existing unverified account', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'ada@example.com',
        passwordHash: '$argon2id$…',
        emailVerifiedAt: null,
      });

      // Per the spec's edge cases: re-registering an unverified address is
      // treated as "I forgot I signed up" and resends the verification mail
      // (phase 2), rather than erroring or creating a second row.
      const result = await service.register(registerDto);

      expect(result.id).toBe('user-1');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    const loginDto = {
      email: 'ada@example.com',
      password: 'correct horse battery staple',
    };

    const verifiedUser: StoredUser = {
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: '$argon2id$…',
      emailVerifiedAt: new Date(),
    };

    it('returns a token pair for correct credentials', async () => {
      const { service, prisma, passwords, refreshTokens } = createMocks();
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      passwords.verify.mockResolvedValue(true);

      expect(await service.login(loginDto)).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
      expect(refreshTokens.issueForNewSession).toHaveBeenCalledWith('user-1');
    });

    it('puts only the user id in the access token', async () => {
      const { service, prisma, passwords, jwt } = createMocks();
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      passwords.verify.mockResolvedValue(true);

      await service.login(loginDto);

      // No role, no permissions: a 15-minute token would cache authority that
      // an admin can revoke at any moment. JwtStrategy re-reads them per
      // request instead.
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'user-1' });
    });

    it('rejects a wrong password', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue(verifiedUser);
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an unknown email exactly like a wrong password', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('still verifies a password when the account does not exist', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      passwords.verify.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );

      // Skipping the hash for unknown emails would make them measurably faster
      // to reject than known ones — the timing oracle PasswordService.verify
      // exists to close. The null hash is what triggers the dummy pass.
      expect(passwords.verify).toHaveBeenCalledWith(null, loginDto.password);
    });

    it('tells a verified-password user that their email is unverified', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...verifiedUser,
        emailVerifiedAt: null,
      });
      passwords.verify.mockResolvedValue(true);

      await expect(service.login(loginDto)).rejects.toThrow(ForbiddenException);
    });

    it('does not reveal an unverified account to someone guessing passwords', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...verifiedUser,
        emailVerifiedAt: null,
      });
      passwords.verify.mockResolvedValue(false);

      // The "verify your email" hint is only earned by proving the password.
      // Checking verification first would turn a wrong guess into a hit,
      // confirming the address is registered.
      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a password login against a passwordless account', async () => {
      const { service, prisma, passwords } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...verifiedUser,
        passwordHash: null,
      });
      passwords.verify.mockResolvedValue(false);

      // A Google-only account. Same generic rejection — anything else would
      // advertise which accounts sign in with Google.
      await expect(service.login(loginDto)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwords.verify).toHaveBeenCalledWith(null, loginDto.password);
    });
  });

  describe('refresh', () => {
    it('mints a fresh access token alongside the rotated refresh token', async () => {
      const { service, refreshTokens, jwt } = createMocks();
      refreshTokens.rotate.mockResolvedValue({
        userId: 'user-1',
        refreshToken: 'next-refresh-token',
      });

      expect(await service.refresh('presented')).toEqual({
        accessToken: 'access-token',
        refreshToken: 'next-refresh-token',
      });
      expect(refreshTokens.rotate).toHaveBeenCalledWith('presented');
      expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'user-1' });
    });

    it('propagates a rejected rotation', async () => {
      const { service, refreshTokens } = createMocks();
      refreshTokens.rotate.mockRejectedValue(new UnauthorizedException());

      await expect(service.refresh('stolen')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('revokes only the session the token belongs to', async () => {
      const { service, refreshTokens } = createMocks();

      await service.logout('user-1', 'presented');

      expect(refreshTokens.revokeSession).toHaveBeenCalledWith(
        'user-1',
        'presented',
      );
      expect(refreshTokens.revokeAllSessions).not.toHaveBeenCalled();
    });
  });
});
