import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';

import { PermissionsGuard } from './authz/permissions.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './strategies/jwt.strategy';

/**
 * Wires authentication + authorization globally.
 *
 * Token *signing* (JwtModule) is intentionally absent: nothing issues tokens
 * yet. Add `JwtModule.registerAsync(...)` here alongside the AuthService that
 * implements login/refresh (see docs/specs/auth.md).
 */
@Module({
  imports: [PassportModule],
  providers: [
    JwtStrategy,
    // Order matters: Nest runs global guards in registration order, so
    // authentication populates request.user before authorization reads it.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}
