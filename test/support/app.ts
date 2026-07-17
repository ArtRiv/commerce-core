import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';

import { AppModule } from '../../src/app.module';
import { MAIL_SERVICE } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeMailService } from './fake-mail.service';

export interface TestApp {
  app: INestApplication<App>;
  prisma: PrismaService;
  mail: FakeMailService;
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

  return { app, prisma: app.get(PrismaService), mail };
}
