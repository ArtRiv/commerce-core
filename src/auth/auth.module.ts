import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PermissionsGuard } from './authz/permissions.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { VerificationTokenService } from './verification-token.service';

const DEFAULT_ACCESS_TOKEN_TTL = '15m';

/** Wires authentication + authorization globally, and issues tokens. */
@Module({
  imports: [
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
    // Order matters: Nest runs global guards in registration order, so
    // authentication populates request.user before authorization reads it.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}
