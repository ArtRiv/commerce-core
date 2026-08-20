import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionsGuard } from './authz/permissions.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import {
  GoogleStrategy,
  isGoogleConfigured,
} from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { VerificationTokenService } from './verification-token.service';

/**
 * Registers GoogleStrategy only where Google sign-in is actually configured.
 *
 * Constructing it demands GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, so an
 * unconditional provider would stop the app — and the test suite — from booting
 * anywhere those are absent. A passport strategy registers itself on
 * construction, so skipping construction leaves it unregistered, and
 * GoogleOAuthGuard answers 503 on the routes that would need it.
 */
const googleStrategyProvider: Provider = {
  provide: GoogleStrategy,
  inject: [ConfigService],
  useFactory: (config: ConfigService): GoogleStrategy | null =>
    isGoogleConfigured(config) ? new GoogleStrategy(config) : null,
};

const DEFAULT_ACCESS_TOKEN_TTL = '15m';

/** Wires authentication + authorization globally, and issues tokens. */
@Module({
  imports: [
    // Explicit since MailModule stopped being @Global (docs/specs/order-emails.md):
    // auth is no longer its only consumer, and the import is what keeps this
    // dependency in the module graph rather than only in the diagram.
    MailModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // Short by design: an access token is never revoked, only outlived.
        //
        // The cast is unavoidable: `expiresIn` is typed as a template-literal
        // union ('15m' | '2 days' | …), and a value read from the environment
        // is just a string. Nothing can check it at compile time; a malformed
        // JWT_ACCESS_TTL fails loudly at boot when jsonwebtoken parses it.
        signOptions: {
          algorithm: 'HS256',
          expiresIn: (config.get<string>('JWT_ACCESS_TTL') ??
            DEFAULT_ACCESS_TOKEN_TTL) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    RefreshTokenService,
    VerificationTokenService,
    JwtStrategy,
    googleStrategyProvider,
    // Order matters: Nest runs global guards in registration order, so
    // authentication populates request.user before authorization reads it.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}
