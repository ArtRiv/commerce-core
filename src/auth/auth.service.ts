import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import type { TokenPair } from './token-pair';

export interface RegisteredUser {
  id: string;
  email: string;
}

/**
 * Addresses are matched case-insensitively. Postgres unique indexes are not,
 * so without this "Ada@example.com" and "ada@example.com" would be two accounts
 * for one mailbox — and Google, which hands back a lowercased address, would
 * fail to auto-link to a mixed-case row when that lands.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const email = normalizeEmail(dto.email);

    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      if (existing.emailVerifiedAt) {
        throw new ConflictException('Email already registered');
      }

      // Signing up again with an address that never got verified is the "I
      // forgot I already did this" case, not an error. Phase 2 resends the
      // verification mail here; either way, no second row.
      return { id: existing.id, email: existing.email };
    }

    // Which role a new account gets is the database's decision, not this
    // service's. Hardcoding 'customer' would break the day it gets renamed,
    // and silently — the lookup would just miss.
    const role = await this.prisma.role.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });

    if (!role) {
      throw new Error('No default role configured — did the seed run?');
    }

    // emailVerifiedAt is left unset: registering proves nothing about owning
    // the address.
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name,
        passwordHash: await this.passwords.hash(dto.password),
        roleId: role.id,
      },
      select: { id: true, email: true },
    });

    return user;
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(dto.email) },
      select: { id: true, passwordHash: true, emailVerifiedAt: true },
    });

    // Runs even when there is no user, and even when the account has no
    // password (Google-only). PasswordService.verify burns an equivalent
    // argon2 pass on a null hash precisely so those cases take as long as a
    // real rejection.
    const matches = await this.passwords.verify(
      user?.passwordHash ?? null,
      dto.password,
    );

    if (!user || !matches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Only after the password checks out. Reversing these two would let anyone
    // typing a wrong password learn that the address is registered but
    // unverified — the generic message above exists to prevent exactly that.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException('Verify your email before signing in');
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.signAccessToken(user.id),
      this.refreshTokens.issueForNewSession(user.id),
    ]);

    return { accessToken, refreshToken };
  }

  async refresh(presented: string): Promise<TokenPair> {
    const { userId, refreshToken } = await this.refreshTokens.rotate(presented);

    return {
      accessToken: await this.signAccessToken(userId),
      refreshToken,
    };
  }

  async logout(userId: string, presented: string): Promise<void> {
    await this.refreshTokens.revokeSession(userId, presented);
  }

  /** Identity only — see docs/specs/auth.md on why no role rides along. */
  private signAccessToken(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId });
  }
}
