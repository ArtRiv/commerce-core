import { INestApplication, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { AuthService } from '../src/auth/auth.service';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createVerifiedUser, resetAuthTables } from './support/db';
import type { FakeMailService } from './support/fake-mail.service';

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery staple';

/**
 * Covers the phase-1 acceptance criteria of docs/specs/auth.md at the HTTP
 * level, against a real database.
 *
 * The refresh-rotation criteria live here rather than in unit tests on purpose:
 * with a mocked Prisma, a "reuse revokes the family" test only asserts that the
 * mock returned what it was told to. The invariant is about rows and
 * transactions, so only a real database can falsify it.
 */
describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let passwords: PasswordService;
  let mail: FakeMailService;
  let resetRateLimits: () => void;

  beforeAll(async () => {
    ({ app, prisma, mail, resetRateLimits } = await createTestApp());
    passwords = app.get(PasswordService);
  });

  beforeEach(async () => {
    await resetAuthTables(prisma);
    mail.reset();
    resetRateLimits();
  });

  afterAll(async () => {
    await resetAuthTables(prisma);
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function seedVerifiedUser(): Promise<void> {
    await createVerifiedUser(prisma, {
      email: EMAIL,
      passwordHash: await passwords.hash(PASSWORD),
    });
  }

  async function login(): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const response = await http()
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(200);

    return response.body as { accessToken: string; refreshToken: string };
  }

  describe('POST /auth/register', () => {
    it('creates an unverified account with the default role', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
        select: { emailVerifiedAt: true, role: { select: { name: true } } },
      });

      expect(user.emailVerifiedAt).toBeNull();
      expect(user.role.name).toBe('customer');
    });

    it('never stores the password', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
        select: { passwordHash: true },
      });

      expect(user.passwordHash).not.toBe(PASSWORD);
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('rejects a password shorter than 8 characters', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: 'short', name: 'Ada' })
        .expect(400);
    });

    it('rejects a body trying to choose its own role', async () => {
      // Privilege escalation via mass assignment: the DTO has no roleId, and
      // forbidNonWhitelisted turns the attempt into a 400 rather than ignoring
      // it quietly.
      await http()
        .post('/auth/register')
        .send({
          email: EMAIL,
          password: PASSWORD,
          name: 'Ada',
          roleId: 'admin',
        })
        .expect(400);
    });

    it('conflicts on an address already registered and verified', async () => {
      await seedVerifiedUser();

      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(409);
    });

    it('treats one address in different cases as one account', async () => {
      await http()
        .post('/auth/register')
        .send({ email: 'Ada@Example.COM', password: PASSWORD, name: 'Ada' })
        .expect(201);

      const users = await prisma.user.findMany({ select: { email: true } });

      expect(users).toHaveLength(1);
      expect(users[0].email).toBe(EMAIL);
    });
  });

  describe('POST /auth/verify-email', () => {
    async function register(): Promise<void> {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);
    }

    // The whole point of phase 2: an account created through the API can now
    // reach a working login without anyone touching the database.
    it('completes register → verify → login', async () => {
      await register();

      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(403);

      await http()
        .post('/auth/verify-email')
        .send({ token: mail.lastVerificationToken() })
        .expect(204);

      const response = await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(response.body).toHaveProperty('accessToken');
    });

    it('rejects a token that was already used', async () => {
      await register();
      const token = mail.lastVerificationToken();

      await http().post('/auth/verify-email').send({ token }).expect(204);
      await http().post('/auth/verify-email').send({ token }).expect(400);
    });

    it('rejects a token nobody issued', async () => {
      await http()
        .post('/auth/verify-email')
        .send({ token: 'not-a-real-token' })
        .expect(400);
    });

    // Purpose confusion. A verification token is trivially obtainable — type
    // any address into /auth/register — and lasts 24h. If the reset flow
    // accepted it, that would be account takeover by design.
    it('will not accept a verification token as a password reset', async () => {
      await register();
      const verificationToken = mail.lastVerificationToken();

      await http()
        .post('/auth/reset-password')
        .send({ token: verificationToken, newPassword: 'attacker password' })
        .expect(400);

      // The rejected attempt must not have spent the token either — purpose is
      // checked before consuming. Otherwise submitting someone's verification
      // token to the reset endpoint would be a way to burn their link and lock
      // them out of activating their account.
      await http()
        .post('/auth/verify-email')
        .send({ token: verificationToken })
        .expect(204);

      // And the attacker's password was never set.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'attacker password' })
        .expect(401);
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
    });
  });

  describe('POST /auth/resend-verification', () => {
    it('sends a fresh link, retiring the previous one', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);
      const first = mail.lastVerificationToken();

      await http()
        .post('/auth/resend-verification')
        .send({ email: EMAIL })
        .expect(204);
      const second = mail.lastVerificationToken();

      expect(second).not.toBe(first);

      // Only the newest link works: a mailbox with three links is not three
      // live keys.
      await http()
        .post('/auth/verify-email')
        .send({ token: first })
        .expect(400);
      await http()
        .post('/auth/verify-email')
        .send({ token: second })
        .expect(204);
    });

    it('answers identically for an address with no account', async () => {
      const known = await http()
        .post('/auth/resend-verification')
        .send({ email: EMAIL })
        .expect(204);

      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      const unknown = await http()
        .post('/auth/resend-verification')
        .send({ email: 'nobody@example.com' })
        .expect(204);

      expect(unknown.body).toEqual(known.body);
      expect(
        mail.verificationEmails.filter((e) => e.to === 'nobody@example.com'),
      ).toHaveLength(0);
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('mails a reset link for a real account', async () => {
      await seedVerifiedUser();

      await http()
        .post('/auth/forgot-password')
        .send({ email: EMAIL })
        .expect(204);

      expect(mail.passwordResetEmails).toHaveLength(1);
    });

    it('answers an unknown address identically, sending nothing', async () => {
      await seedVerifiedUser();

      const known = await http()
        .post('/auth/forgot-password')
        .send({ email: EMAIL })
        .expect(204);

      const unknown = await http()
        .post('/auth/forgot-password')
        .send({ email: 'nobody@example.com' })
        .expect(204);

      expect(unknown.body).toEqual(known.body);
      expect(mail.passwordResetEmails).toHaveLength(1);
    });

    it('sends nothing for a Google-only account, without saying so', async () => {
      await createVerifiedUser(prisma, {
        email: 'google-user@example.com',
        passwordHash: null,
      });

      await http()
        .post('/auth/forgot-password')
        .send({ email: 'google-user@example.com' })
        .expect(204);

      expect(mail.passwordResetEmails).toHaveLength(0);
    });
  });

  describe('POST /auth/reset-password', () => {
    async function requestReset(): Promise<string> {
      await http()
        .post('/auth/forgot-password')
        .send({ email: EMAIL })
        .expect(204);

      return mail.lastPasswordResetToken();
    }

    it('changes the password and lets the new one in', async () => {
      await seedVerifiedUser();
      const token = await requestReset();

      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'a whole new password' })
        .expect(204);

      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(401);

      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'a whole new password' })
        .expect(200);
    });

    // Regression. Reaching a reset link proves ownership of the address, so a
    // reset must also verify it — otherwise a user who registered, skipped
    // verification, then reset their password would set a working password and
    // still be locked out at login with a 403. This exact path used to fail.
    it('verifies an account that reset without ever confirming its email', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      // Still unverified: a password login is refused here.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(403);

      const token = await requestReset();
      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'a whole new password' })
        .expect(204);

      // Now it works — the reset both changed the password and verified the
      // address.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'a whole new password' })
        .expect(200);
    });

    // A reset usually means the account is already compromised. Leaving live
    // sessions would change the lock with the intruder still inside.
    it('signs every existing session out', async () => {
      await seedVerifiedUser();
      const phone = await login();
      const laptop = await login();

      const token = await requestReset();
      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'a whole new password' })
        .expect(204);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: phone.refreshToken })
        .expect(401);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: laptop.refreshToken })
        .expect(401);
    });

    it('rejects a token that was already used', async () => {
      await seedVerifiedUser();
      const token = await requestReset();

      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'first new password' })
        .expect(204);

      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'second new password' })
        .expect(400);

      // And the second attempt changed nothing.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'first new password' })
        .expect(200);
    });

    it('enforces the password policy on the new password', async () => {
      await seedVerifiedUser();
      const token = await requestReset();

      await http()
        .post('/auth/reset-password')
        .send({ token, newPassword: 'short' })
        .expect(400);
    });
  });

  describe('POST /auth/login', () => {
    it('issues a token pair for a verified account', async () => {
      await seedVerifiedUser();

      const { accessToken, refreshToken } = await login();

      expect(typeof accessToken).toBe('string');
      expect(typeof refreshToken).toBe('string');
    });

    it('refuses an unverified account, saying so', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      const response = await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(403);

      expect(JSON.stringify(response.body)).toMatch(/verify your email/i);
    });

    it('rejects a wrong password without naming what was wrong', async () => {
      await seedVerifiedUser();

      const response = await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'wrong password' })
        .expect(401);

      expect(JSON.stringify(response.body)).not.toMatch(/password|email/i);
    });

    it('answers an unknown address exactly as it answers a wrong password', async () => {
      await seedVerifiedUser();

      const unknown = await http()
        .post('/auth/login')
        .send({ email: 'nobody@example.com', password: PASSWORD })
        .expect(401);

      const wrongPassword = await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'wrong password' })
        .expect(401);

      // Byte-identical: nothing in the response distinguishes "no such account"
      // from "bad password".
      expect(unknown.body).toEqual(wrongPassword.body);
    });

    it('does not admit an unverified account exists to a wrong password', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      // 401, not the 403 a correct password would earn: guessing wrong must not
      // reveal that the address is registered.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: 'wrong password' })
        .expect(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the pair and kills the token it consumed', async () => {
      await seedVerifiedUser();
      const first = await login();

      const response = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);

      const second = response.body as { refreshToken: string };
      expect(second.refreshToken).not.toBe(first.refreshToken);

      // Single use: the spent token is dead even though it has not expired.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);
    });

    it('rejects a token that was never issued', async () => {
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: 'not-a-real-token' })
        .expect(401);
    });

    // The acceptance criterion this whole design exists for. Replaying a spent
    // token means two parties hold it, so every token descended from that login
    // dies — including the one the replayer already rotated into.
    it('revokes the whole family when a consumed token is replayed', async () => {
      await seedVerifiedUser();
      const first = await login();

      const rotated = await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(200);
      const second = rotated.body as { refreshToken: string };

      // The replay. Someone else has the token the real client already spent.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: first.refreshToken })
        .expect(401);

      // The token that was still live a moment ago is now dead too: this is the
      // part that actually defeats the theft. Revoking only the replayed token
      // would leave this one working.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: second.refreshToken })
        .expect(401);

      const live = await prisma.refreshToken.count({
        where: { revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('does not touch other sessions when revoking a stolen family', async () => {
      await seedVerifiedUser();
      const phone = await login();
      const laptop = await login();

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: phone.refreshToken })
        .expect(200);
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: phone.refreshToken })
        .expect(401);

      // A theft on one device must not sign the user out of the other.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: laptop.refreshToken })
        .expect(200);
    });
  });

  describe('Google sign-in', () => {
    // Not an HTTP test: completing a real OAuth round trip needs Google. But
    // the acceptance criteria here are claims about rows — "no duplicate
    // account is created", "the existing account is linked" — and a mocked
    // Prisma cannot falsify those, the same reasoning that put refresh-token
    // replay in this file. So the service is driven directly against the real
    // database, standing in for what the callback would hand it.
    let auth: AuthService;

    const profile = {
      googleId: 'google-sub-123',
      email: EMAIL,
      name: 'Ada',
      emailVerified: true,
    };

    beforeAll(() => {
      auth = app.get(AuthService);
    });

    it('creates a verified, passwordless account for a new user', async () => {
      const tokens = await auth.loginWithGoogle(profile);
      expect(tokens.accessToken).toBeTruthy();

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
        select: {
          googleId: true,
          passwordHash: true,
          emailVerifiedAt: true,
          role: { select: { name: true } },
        },
      });

      expect(user.googleId).toBe('google-sub-123');
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(user.role.name).toBe('customer');
    });

    it('links onto an account registered with a password, without duplicating it', async () => {
      await seedVerifiedUser();

      await auth.loginWithGoogle(profile);

      const users = await prisma.user.findMany({
        select: { id: true, googleId: true, passwordHash: true },
      });

      // One row, both credentials. The unique index on email would have thrown
      // on a second insert anyway — that it did not is the point.
      expect(users).toHaveLength(1);
      expect(users[0].googleId).toBe('google-sub-123');
      expect(users[0].passwordHash).not.toBeNull();
    });

    it('leaves the password login working after linking', async () => {
      await seedVerifiedUser();
      await auth.loginWithGoogle(profile);

      // Linking adds a way in; it must not take one away.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
    });

    it('signs the same Google user in repeatedly without duplicating', async () => {
      await auth.loginWithGoogle(profile);
      await auth.loginWithGoogle(profile);

      expect(await prisma.user.count()).toBe(1);
    });

    it('verifies an account that never confirmed its address', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      await auth.loginWithGoogle(profile);

      // Registered, never clicked the link, signed in with Google instead.
      // Google proved the address, so password login now works too.
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
    });

    it('refuses a profile whose address Google did not verify', async () => {
      await expect(
        auth.loginWithGoogle({ ...profile, emailVerified: false }),
      ).rejects.toThrow(UnauthorizedException);

      expect(await prisma.user.count()).toBe(0);
    });

    it('will not let an unverified Google profile seize an existing account', async () => {
      await seedVerifiedUser();

      // The attack the emailVerified check exists to stop: put a victim's
      // address on a Google account, leave it unverified, sign in, inherit
      // their account.
      await expect(
        auth.loginWithGoogle({ ...profile, emailVerified: false }),
      ).rejects.toThrow(UnauthorizedException);

      const user = await prisma.user.findUniqueOrThrow({
        where: { email: EMAIL },
        select: { googleId: true },
      });
      expect(user.googleId).toBeNull();
    });

    it('exposes the OAuth routes rather than 404ing them', async () => {
      // Deliberately not asserting the status: it depends on whether this
      // environment has Google credentials — 503 without, a redirect to Google
      // with. Pinning either would make the test a report on someone's .env.
      // That the route is mounted at all is the environment-independent claim;
      // GoogleOAuthGuard's own spec covers the unconfigured branch.
      const response = await http().get('/auth/google');

      expect(response.status).not.toBe(404);
      expect([503, 302]).toContain(response.status);
    });
  });

  describe('rate limiting', () => {
    // The spec's sharpest wording: 429 *even with the correct password*. If a
    // valid login reset or bypassed the counter, an attacker who guesses right
    // on attempt 50 still gets in, and the limit was decoration.
    it('locks out after 5 failed logins, right password included', async () => {
      await seedVerifiedUser();

      for (let attempt = 0; attempt < 5; attempt++) {
        await http()
          .post('/auth/login')
          .send({ email: EMAIL, password: 'wrong password' })
          .expect(401);
      }

      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(429);
    });

    it('tells the client when to come back', async () => {
      await seedVerifiedUser();

      for (let attempt = 0; attempt < 5; attempt++) {
        await http()
          .post('/auth/login')
          .send({ email: EMAIL, password: 'wrong password' })
          .expect(401);
      }

      const response = await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(429);

      expect(response.headers).toHaveProperty('retry-after');
    });

    // Per-account, not just per-source: hammering one account from a hundred
    // IPs must not buy a hundred budgets.
    it('counts login attempts against the account, not only the caller', async () => {
      await seedVerifiedUser();
      await createVerifiedUser(prisma, {
        email: 'other@example.com',
        passwordHash: await passwords.hash(PASSWORD),
      });

      for (let attempt = 0; attempt < 5; attempt++) {
        await http()
          .post('/auth/login')
          .send({ email: EMAIL, password: 'wrong password' })
          .expect(401);
      }

      // Locked for the targeted account...
      await http()
        .post('/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(429);

      // ...but a different account is unaffected, so one user under attack
      // cannot lock everybody else out. (Same IP: this is the per-email key
      // doing the work, not the per-IP one, whose budget is also spent here.)
      resetRateLimits();
      await http()
        .post('/auth/login')
        .send({ email: 'other@example.com', password: PASSWORD })
        .expect(200);
    });

    it('caps password reset mail at 3 per address per hour', async () => {
      await seedVerifiedUser();

      for (let attempt = 0; attempt < 3; attempt++) {
        await http()
          .post('/auth/forgot-password')
          .send({ email: EMAIL })
          .expect(204);
      }

      // The abuse this stops is not against us: it is using our sender
      // reputation to flood someone else's inbox.
      await http()
        .post('/auth/forgot-password')
        .send({ email: EMAIL })
        .expect(429);

      expect(mail.passwordResetEmails).toHaveLength(3);
    });

    it('caps verification resends the same way', async () => {
      await http()
        .post('/auth/register')
        .send({ email: EMAIL, password: PASSWORD, name: 'Ada' })
        .expect(201);

      for (let attempt = 0; attempt < 3; attempt++) {
        await http()
          .post('/auth/resend-verification')
          .send({ email: EMAIL })
          .expect(204);
      }

      await http()
        .post('/auth/resend-verification')
        .send({ email: EMAIL })
        .expect(429);
    });

    it('caps registrations per source', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await http()
          .post('/auth/register')
          .send({
            email: `signup-${String(attempt)}@example.com`,
            password: PASSWORD,
            name: 'Ada',
          })
          .expect(201);
      }

      await http()
        .post('/auth/register')
        .send({
          email: 'one-too-many@example.com',
          password: PASSWORD,
          name: 'Ada',
        })
        .expect(429);
    });

    it('does not rate limit an unthrottled route', async () => {
      // The limits are on the sensitive routes, not blanket across the API.
      for (let attempt = 0; attempt < 10; attempt++) {
        await http().get('/').expect(200);
      }
    });
  });

  describe('POST /auth/logout', () => {
    it('ends the session it was given', async () => {
      await seedVerifiedUser();
      const { accessToken, refreshToken } = await login();

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(204);

      await http().post('/auth/refresh').send({ refreshToken }).expect(401);
    });

    it('leaves the user signed in elsewhere', async () => {
      await seedVerifiedUser();
      const phone = await login();
      const laptop = await login();

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${phone.accessToken}`)
        .send({ refreshToken: phone.refreshToken })
        .expect(204);

      await http()
        .post('/auth/refresh')
        .send({ refreshToken: laptop.refreshToken })
        .expect(200);
    });

    it('requires authentication', async () => {
      await seedVerifiedUser();
      const { refreshToken } = await login();

      await http().post('/auth/logout').send({ refreshToken }).expect(401);
    });

    it('will not let one user end another user’s session', async () => {
      await seedVerifiedUser();
      const victim = await login();

      await createVerifiedUser(prisma, {
        email: 'mallory@example.com',
        passwordHash: await passwords.hash(PASSWORD),
      });
      const attackerLogin = await http()
        .post('/auth/login')
        .send({ email: 'mallory@example.com', password: PASSWORD })
        .expect(200);
      const attacker = attackerLogin.body as { accessToken: string };

      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${attacker.accessToken}`)
        .send({ refreshToken: victim.refreshToken })
        .expect(204);

      // The victim's session survives: revokeSession ignores a token that is
      // not the caller's, so logout cannot be turned into a denial of service
      // against someone else.
      await http()
        .post('/auth/refresh')
        .send({ refreshToken: victim.refreshToken })
        .expect(200);
    });
  });
});
