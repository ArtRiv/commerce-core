import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // A baseline for any route that opts in with @UseGuards(ThrottlerGuard);
    // the sensitive routes override it with their own @Throttle. Storage is
    // in-memory, which means each instance counts on its own — fine for one
    // process, wrong the day this runs behind more than one. Swapping in the
    // Redis storage is a change here and nowhere else.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    PrismaModule,
    MailModule,
    AuthModule,
    CatalogModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      // Registered as a provider rather than via app.useGlobalPipes() in
      // main.ts so it is part of the module graph: anything that builds the app
      // from AppModule — the e2e suite above all — validates exactly like
      // production does. A pipe wired only in main.ts silently disappears in
      // tests, which is how DTO rules end up untested.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // Strip unknown properties, and reject rather than ignore them: a body
        // carrying `roleId` should fail loudly, not have it quietly dropped.
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
