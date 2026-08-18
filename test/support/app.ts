import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageService } from '@nestjs/throttler/dist/throttler.service';
import type { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { MAIL_SERVICE } from '../../src/mail/mail.service';
import { STRIPE_CLIENT } from '../../src/payments/stripe-client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeMailService } from './fake-mail.service';
import { OfflineStripe } from './offline-stripe';

/**
 * Forced rather than defaulted, so a developer's real Stripe keys in .env can
 * never take part in a test run. ConfigModule loads .env without overriding
 * variables that are already set, so setting them here wins.
 */
const STRIPE_TEST_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_offline',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_offline',
};

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  mail: FakeMailService;
  /** The gateway double: inspect issued sessions, sign webhook payloads. */
  stripe: OfflineStripe;
  /** The secret the app verifies against — tests sign with this. */
  webhookSecret: string;
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
 * database — with two seams replaced.
 *
 * Mail is replaced wholesale, for two reasons: a test suite must not send mail
 * to anyone, and ResendMailService demands RESEND_API_KEY at construction, so
 * the app would not boot here without it. ResendMailService is therefore not
 * covered by any test; everything up to that boundary is.
 *
 * Stripe is replaced far more narrowly. The real StripePaymentProvider is bound
 * and exercised; only the SDK's two network calls are answered from memory,
 * while webhooks.constructEvent stays the SDK's own. Signature verification,
 * raw-body handling and event translation are all genuinely under test.
 */
export async function createTestApp(): Promise<TestApp> {
  Object.assign(process.env, STRIPE_TEST_ENV);

  const mail = new FakeMailService();
  const stripe = new OfflineStripe();

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAIL_SERVICE)
    .useValue(mail)
    .overrideProvider(STRIPE_CLIENT)
    .useValue(stripe)
    .compile();

  // rawBody mirrors main.ts. Without it the webhook route has no bytes to
  // verify a signature against, and every delivery would 400 — in tests only,
  // which is exactly the kind of divergence that makes an e2e worthless.
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  await app.init();

  const storage = app.get<ThrottlerStorageService>(ThrottlerStorage);

  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    stripe,
    webhookSecret: STRIPE_TEST_ENV.STRIPE_WEBHOOK_SECRET,
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
