import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createVerifiedUser, resetAuthTables } from './support/db';

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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    passwords = app.get(PasswordService);
  });

  beforeEach(async () => {
    await resetAuthTables(prisma);
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
