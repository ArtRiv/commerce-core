import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../authenticated-user';
import { resolveEffectivePermissions } from '../authz/role-permissions';

/**
 * Claims carried by the access token. Deliberately minimal: identity only.
 * Permissions are resolved from the DB on every request (see `validate`), never
 * read from the token — a token is a 15-minute snapshot, and roles are editable
 * at runtime, so a baked-in permission list would go stale and over-grant.
 */
interface JwtPayload {
  sub: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      // Pin the algorithm on the *verify* side. The signer already emits HS256,
      // but the verifier is where it matters: without this, a token is accepted
      // for any algorithm the library allows, and the classic JWT attack is to
      // re-sign with a different one. Belt and braces even with a symmetric
      // secret — it costs one line and removes the whole class of confusion.
      algorithms: ['HS256'],
    });
  }

  /**
   * Runs after the token signature and expiry check pass. Whatever this returns
   * becomes `request.user`.
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: {
          select: {
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
        permissionsGrantedToUser: {
          select: { permission: { select: { key: true } } },
        },
      },
    });

    // A token can outlive the user it names (deleted account, revoked access).
    if (!user) {
      throw new UnauthorizedException();
    }

    const permissions = resolveEffectivePermissions(
      user.role.permissions.map((rp) => rp.permission.key),
      user.permissionsGrantedToUser.map((up) => up.permission.key),
    );

    return { id: user.id, role: user.role.name, permissions };
  }
}
