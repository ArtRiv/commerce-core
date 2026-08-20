import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';

import { VerificationTokenPurpose } from '../generated/prisma/enums';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import type { RefreshTokenService } from './refresh-token.service';
import type { VerificationTokenService } from './verification-token.service';

const { EMAIL_VERIFICATION, PASSWORD_RESET } = VerificationTokenPurpose;

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
    name: string | null;
    roleId: string;
    // Optional: a Google account arrives with no password but a googleId and a
    // verification date, a registered one with the reverse.
    passwordHash?: string;
    googleId?: string;
    emailVerifiedAt?: Date;
  };
}

interface UserUpdateArgs {
  where: { id: string };
  data: {
    emailVerifiedAt?: Date | null;
    passwordHash?: string;
    googleId?: string;
  };
}

interface UserUpdateManyArgs {
  where: { id: string; emailVerifiedAt: null };
  data: { emailVerifiedAt: Date };
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
      update: jest
        .fn<Promise<unknown>, [UserUpdateArgs]>()
        .mockResolvedValue({}),
      updateMany: jest
        .fn<Promise<{ count: number }>, [UserUpdateManyArgs]>()
        .mockResolvedValue({ count: 1 }),
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

  const verificationTokens = {
    issue: jest
      .fn<Promise<string>, [string, VerificationTokenPurpose]>()
      .mockResolvedValue('verification-token'),
    consume: jest.fn<Promise<string>, [string, VerificationTokenPurpose]>(),
  };

  const mail = {
    sendVerificationEmail: jest
      .fn<Promise<void>, [string, string]>()
      .mockResolvedValue(undefined),
    sendPasswordResetEmail: jest
      .fn<Promise<void>, [string, string]>()
      .mockResolvedValue(undefined),
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
    verificationTokens as unknown as VerificationTokenService,
    jwt as unknown as JwtService,
    // Only the two methods auth uses are stubbed; the order emails are not
    // this module's business, and a cast keeps them out of every auth test.
    mail as unknown as MailService,
  );

  return {
    service,
    prisma,
    passwords,
    refreshTokens,
    verificationTokens,
    jwt,
    mail,
  };
}

const EMAIL = 'ada@example.com';

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

    it('does not duplicate an existing unverified account, and resends the link', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'ada@example.com',
        passwordHash: '$argon2id$…',
        emailVerifiedAt: null,
      });

      // Per the spec's edge cases: re-registering an unverified address is
      // treated as "I forgot I signed up" — resend the mail, no second row.
      const result = await service.register(registerDto);

      expect(result.id).toBe('user-1');
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(mail.sendVerificationEmail).toHaveBeenCalled();
    });

    it('mails a verification link to a new account', async () => {
      const { service, prisma, mail, verificationTokens } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.register(registerDto);

      expect(verificationTokens.issue).toHaveBeenCalledWith(
        'user-1',
        EMAIL_VERIFICATION,
      );
      expect(mail.sendVerificationEmail).toHaveBeenCalledWith(
        EMAIL,
        'verification-token',
      );
    });

    // Spec edge case, and the reason the send is wrapped rather than awaited
    // bare: the account exists and is fine, the user can ask for another link,
    // and losing the sign-up over a provider's bad minute is the worse failure.
    it('still registers when the mail provider is down', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      mail.sendVerificationEmail.mockRejectedValue(new Error('Resend is down'));

      const result = await service.register(registerDto);

      expect(result.id).toBe('user-1');
      expect(prisma.user.create).toHaveBeenCalled();
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

  describe('verifyEmail', () => {
    it('marks the address verified', async () => {
      const { service, prisma, verificationTokens } = createMocks();
      verificationTokens.consume.mockResolvedValue('user-1');

      await service.verifyEmail('token');

      expect(verificationTokens.consume).toHaveBeenCalledWith(
        'token',
        EMAIL_VERIFICATION,
      );
      const [update] = prisma.user.update.mock.calls[0];
      expect(update.where.id).toBe('user-1');
      expect(update.data.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('does not verify anything when the token is rejected', async () => {
      const { service, prisma, verificationTokens } = createMocks();
      verificationTokens.consume.mockRejectedValue(new BadRequestException());

      await expect(service.verifyEmail('bad')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('resendVerification', () => {
    it('sends a fresh link to an unverified account', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: EMAIL,
        passwordHash: '$argon2id$…',
        emailVerifiedAt: null,
      });

      await service.resendVerification(EMAIL);

      expect(mail.sendVerificationEmail).toHaveBeenCalledWith(
        EMAIL,
        'verification-token',
      );
    });

    it('stays silent for an unknown address', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      // Resolves, sends nothing. An error — or any observable difference —
      // would make this endpoint an account-existence check.
      await expect(service.resendVerification(EMAIL)).resolves.toBeUndefined();
      expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('stays silent for an already-verified account', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: EMAIL,
        passwordHash: '$argon2id$…',
        emailVerifiedAt: new Date(),
      });

      await expect(service.resendVerification(EMAIL)).resolves.toBeUndefined();
      expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it('mails a reset link to an account that has a password', async () => {
      const { service, prisma, mail, verificationTokens } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: EMAIL,
        passwordHash: '$argon2id$…',
        emailVerifiedAt: new Date(),
      });

      await service.forgotPassword(EMAIL);

      expect(verificationTokens.issue).toHaveBeenCalledWith(
        'user-1',
        PASSWORD_RESET,
      );
      expect(mail.sendPasswordResetEmail).toHaveBeenCalledWith(
        EMAIL,
        'verification-token',
      );
    });

    it('answers an unknown address the same way, sending nothing', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.forgotPassword(EMAIL)).resolves.toBeUndefined();
      expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('sends nothing for a Google-only account, without saying so', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: EMAIL,
        passwordHash: null,
        emailVerifiedAt: new Date(),
      });

      // There is no password to reset. The response still cannot differ, or it
      // would reveal that this address signs in with Google.
      await expect(service.forgotPassword(EMAIL)).resolves.toBeUndefined();
      expect(mail.sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('sets the new password and signs every session out', async () => {
      const { service, prisma, passwords, refreshTokens, verificationTokens } =
        createMocks();
      verificationTokens.consume.mockResolvedValue('user-1');

      await service.resetPassword('token', 'a brand new password');

      expect(verificationTokens.consume).toHaveBeenCalledWith(
        'token',
        PASSWORD_RESET,
      );
      expect(passwords.hash).toHaveBeenCalledWith('a brand new password');

      const [update] = prisma.user.update.mock.calls[0];
      expect(update.data.passwordHash).toBe('$argon2id$…');

      // Every family, not just one: a reset usually means the account is
      // compromised, and leaving live sessions would let the intruder keep the
      // one they already have.
      expect(refreshTokens.revokeAllSessions).toHaveBeenCalledWith('user-1');
      expect(refreshTokens.revokeSession).not.toHaveBeenCalled();
    });

    it('verifies the address, but only if it was not already', async () => {
      const { service, prisma, verificationTokens } = createMocks();
      verificationTokens.consume.mockResolvedValue('user-1');

      await service.resetPassword('token', 'a brand new password');

      // Opening the emailed link proves ownership, so a pending verification is
      // satisfied. Scoped to emailVerifiedAt:null so an already-verified
      // account keeps its original date rather than having it rewritten.
      const [verify] = prisma.user.updateMany.mock.calls[0];
      expect(verify.where).toEqual({ id: 'user-1', emailVerifiedAt: null });
      expect(verify.data.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('changes nothing when the token is rejected', async () => {
      const { service, prisma, refreshTokens, verificationTokens } =
        createMocks();
      verificationTokens.consume.mockRejectedValue(new BadRequestException());

      await expect(service.resetPassword('bad', 'whatever')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(refreshTokens.revokeAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('loginWithGoogle', () => {
    const profile = {
      googleId: 'google-sub-123',
      email: EMAIL,
      name: 'Ada',
      emailVerified: true,
    };

    it('creates a verified, passwordless account for a new user', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.loginWithGoogle(profile);

      const [{ data }] = prisma.user.create.mock.calls[0];
      expect(data.googleId).toBe('google-sub-123');
      expect(data.roleId).toBe('role-customer');
      // Verified on the spot: Google's assertion is what our own verification
      // email would have proven. And no password was ever set.
      expect(data.emailVerifiedAt).toBeInstanceOf(Date);
      expect(data.passwordHash).toBeUndefined();
    });

    it('links to an existing account with the same address, creating nothing', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(null) // by googleId
        .mockResolvedValueOnce({
          id: 'user-1',
          email: EMAIL,
          passwordHash: '$argon2id$…',
          emailVerifiedAt: new Date('2020-01-01'),
        });

      await service.loginWithGoogle(profile);

      expect(prisma.user.create).not.toHaveBeenCalled();
      const [update] = prisma.user.update.mock.calls[0];
      expect(update.where.id).toBe('user-1');
      expect(update.data.googleId).toBe('google-sub-123');
    });

    it('keeps the original verification date when linking', async () => {
      const { service, prisma } = createMocks();
      const verifiedAt = new Date('2020-01-01');
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'user-1',
        email: EMAIL,
        passwordHash: '$argon2id$…',
        emailVerifiedAt: verifiedAt,
      });

      await service.loginWithGoogle(profile);

      const [update] = prisma.user.update.mock.calls[0];
      expect(update.data.emailVerifiedAt).toEqual(verifiedAt);
    });

    it('verifies an unverified account it links to', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'user-1',
        email: EMAIL,
        passwordHash: '$argon2id$…',
        emailVerifiedAt: null,
      });

      await service.loginWithGoogle(profile);

      // Registered with a password, never clicked the link, then signed in with
      // Google instead. Google proved the address, so the pending verification
      // is satisfied.
      const [update] = prisma.user.update.mock.calls[0];
      expect(update.data.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('matches on the google id before the address', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValueOnce({
        id: 'user-1',
        email: 'changed@example.com',
        passwordHash: null,
        emailVerifiedAt: new Date(),
      });

      await service.loginWithGoogle(profile);

      // The subject id is stable; an address can be reassigned to someone else
      // by whoever owns the domain. Found by id, so no link and no create.
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      const [lookup] = prisma.user.findUnique.mock.calls[0];
      expect(lookup.where).toEqual({ googleId: 'google-sub-123' });
    });

    // The security boundary of the entire feature. The auto-link is only safe
    // because Google asserts this person owns this mailbox — that assertion is
    // what stands in for our own verification email. Google returns unverified
    // addresses for some Workspace setups; trusting one would let anyone who
    // can put a victim's address on a Google account seize the matching
    // account here.
    it('refuses a profile whose email Google did not verify', async () => {
      const { service, prisma } = createMocks();

      await expect(
        service.loginWithGoogle({ ...profile, emailVerified: false }),
      ).rejects.toThrow(UnauthorizedException);

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('lowercases the address before matching', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      await service.loginWithGoogle({ ...profile, email: 'Ada@Example.COM' });

      const [, byEmail] = prisma.user.findUnique.mock.calls;
      expect(byEmail[0].where).toEqual({ email: EMAIL });
    });

    it('returns a token pair', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      expect(await service.loginWithGoogle(profile)).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
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
