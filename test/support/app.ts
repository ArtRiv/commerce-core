import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';
import type { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { MAIL_SERVICE } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeMailService } from './fake-mail.service';

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  mail: FakeMailService;
  /**
   * Forgets every rate-limit counter.
   *
   * Every test calls from the same loopback address, so without this the
   * budgets leak across cases and a test fails because of what the previous one
   * did. Resetting beats raising the limits for tests: the real numbers stay
   * under test, including the 429.
   */
  resetRateLimits: () => void;
}

/**
 * Boots the real application — real modules, real guards, real pipes, real
 * database — with the mail provider swapped for a fake.
 *
 * Mail is the one seam that gets replaced, for two reasons: a test suite must
 * not send mail to anyone, and ResendMailService demands RESEND_API_KEY at
 * construction, so the app would not boot here without it. Overriding the token
 * means the Resend class is never instantiated.
 *
 * The trade-off is honest but worth naming: ResendMailService itself is
 * therefore not covered by any test. Everything up to the provider boundary is.
 */
export async function createTestApp(): Promise<TestApp> {
  const mail = new FakeMailService();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAIL_SERVICE)
    .useValue(mail)
    .compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  await app.init();

  const storage = app.get<ThrottlerStorageService>(ThrottlerStorage);

  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    resetRateLimits: () => {
      // Cancel the pending cleanup timers before dropping the records they
      // point at. Each increment schedules a setTimeout that, when it fires,
      // reads storage.get(key) and destructures it — so clearing storage alone
      // leaves timers that crash on a now-missing key a moment later, in
      // whatever test happens to be running then. timeoutIds is the service's
      // own registry of those timers; this mirrors its clearExpirationTimes
      // across every throttler name.
      const { timeoutIds } = storage as unknown as {
        timeoutIds: Map<string, NodeJS.Timeout[]>;
      };
      for (const ids of timeoutIds.values()) {
        ids.forEach(clearTimeout);
      }
      timeoutIds.clear();
      storage.storage.clear();
    },
  };
}
