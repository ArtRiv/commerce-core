import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { VerificationTokenPurpose } from '../generated/prisma/enums';
import { MAIL_SERVICE, type MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import type { TokenPair } from './token-pair';
import { VerificationTokenService } from './verification-token.service';

export interface RegisteredUser {
  id: string;
  email: string;
}

/** What GoogleStrategy hands over once Google has vouched for the user. */
export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
  /** Google's own `email_verified`. Load-bearing — see `loginWithGoogle`. */
  emailVerified: boolean;
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly verificationTokens: VerificationTokenService,
    private readonly jwt: JwtService,
    @Inject(MAIL_SERVICE) private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisteredUser> {
    const email = normalizeEmail(dto.email);

    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      if (existing.emailVerifiedAt) {
        throw new ConflictException('Email already registered');
      }

      // Signing up again with an address that never got verified is the "I
      // forgot I already did this" case, not an error: resend the link, no
      // second row.
      await this.sendVerificationEmail(existing.id, existing.email);

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

    await this.sendVerificationEmail(user.id, user.email);

    return user;
  }

  /** Confirms an address, which is what unlocks password login. */
  async verifyEmail(token: string): Promise<void> {
    const userId = await this.verificationTokens.consume(
      token,
      VerificationTokenPurpose.EMAIL_VERIFICATION,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
  }

  /**
   * Always resolves, whatever the address is.
   *
   * Nothing is reported back about unknown or already-verified accounts: this
   * endpoint is public and takes an arbitrary email, so any difference in
   * response — or in whether mail goes out — is an account-existence check
   * anyone can run.
   */
  async resendVerification(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    if (!user || user.emailVerifiedAt) {
      return;
    }

    await this.sendVerificationEmail(user.id, user.email);
  }

  /**
   * Always resolves — see docs/security.md on account enumeration. The caller
   * cannot tell "sent" from "no such account" from "that account signs in with
   * Google", because the only honest answer to all three is the same one.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { id: true, email: true, passwordHash: true },
    });

    // No account, or a Google-only one with no password to reset. Sending a
    // reset link for a password that does not exist would be nonsense, and
    // saying so would leak how the account signs in.
    if (!user?.passwordHash) {
      return;
    }

    const token = await this.verificationTokens.issue(
      user.id,
      VerificationTokenPurpose.PASSWORD_RESET,
    );

    // Not swallowed, unlike registration's: the entire point of the request was
    // to send this, and there is no account left half-made if it fails.
    await this.mail.sendPasswordResetEmail(user.email, token);
  }

  /**
   * Sets a new password, verifies the address, and signs every session out.
   *
   * The revocation is the security-relevant half. Someone resetting a password
   * is often doing it *because* the account is compromised, so leaving existing
   * refresh tokens alive would let the intruder keep the session they already
   * have — the reset would change the lock and leave them inside. This is the
   * one operation that sweeps every family, not just one.
   *
   * It also verifies the email. Reaching a reset token means the user opened a
   * link we mailed to that address, which is the same proof of ownership our
   * verification email asks for and the same proof Google sign-in relies on —
   * so an account that never confirmed its address is confirmed now. Without
   * this, a user who registered, skipped verification, then reset their
   * password would set a working password and still be unable to log in
   * (a real bug this replaced: the reset succeeded and login still 403'd).
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.verificationTokens.consume(
      token,
      VerificationTokenPurpose.PASSWORD_RESET,
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await this.passwords.hash(newPassword) },
    });

    // Conditional so an already-verified account keeps its original date,
    // matching loginWithGoogle. A no-op when emailVerifiedAt is already set.
    await this.prisma.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });

    await this.refreshTokens.revokeAllSessions(userId);
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

    return this.issueTokensFor(user.id);
  }

  /**
   * Signs in through Google, creating or linking an account as needed.
   *
   * `emailVerified` is the security boundary of this whole feature, not a
   * formality. The auto-link is only safe because Google is asserting that this
   * person owns this mailbox — that assertion is what substitutes for our own
   * verification email. Google will hand back unverified addresses for some
   * Workspace configurations, and taking one at face value would mean anyone
   * able to put a victim's address on a Google account could claim the matching
   * account here. Without the assertion there is nothing to link on, so the
   * sign-in is refused rather than guessed at.
   *
   * Matched on googleId first, email second: the subject id is stable, while an
   * address can be reassigned to a different person by whoever owns the domain.
   */
  async loginWithGoogle(profile: GoogleProfile): Promise<TokenPair> {
    if (!profile.emailVerified) {
      throw new UnauthorizedException(
        'Google did not verify this email address',
      );
    }

    const email = normalizeEmail(profile.email);

    const linked = await this.prisma.user.findUnique({
      where: { googleId: profile.googleId },
      select: { id: true },
    });

    if (linked) {
      return this.issueTokensFor(linked.id);
    }

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailVerifiedAt: true },
    });

    if (existing) {
      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleId: profile.googleId,
          // Google just proved ownership, so an address still waiting on our
          // own verification email is now verified. Kept if already set, so the
          // original verification date is not rewritten.
          emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        },
      });

      return this.issueTokensFor(existing.id);
    }

    const role = await this.prisma.role.findFirst({
      where: { isDefault: true },
      select: { id: true },
    });

    if (!role) {
      throw new Error('No default role configured — did the seed run?');
    }

    // No passwordHash: this account has never had one. Verified on the spot —
    // Google's assertion is what our own verification email would have proven.
    const created = await this.prisma.user.create({
      data: {
        email,
        name: profile.name,
        googleId: profile.googleId,
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    return this.issueTokensFor(created.id);
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

  /**
   * Issues a verification token and mails it, tolerating a mail outage.
   *
   * A provider being down must not fail registration: the account is already
   * valid, and the user can ask for another link. Losing the sign-up because
   * Resend had a bad minute would be the worse outcome, so the send is logged
   * and swallowed.
   *
   * Only the *send* is forgiven. If issuing the token fails the database is in
   * trouble, and that error is allowed to surface.
   */
  private async sendVerificationEmail(
    userId: string,
    email: string,
  ): Promise<void> {
    const token = await this.verificationTokens.issue(
      userId,
      VerificationTokenPurpose.EMAIL_VERIFICATION,
    );

    try {
      await this.mail.sendVerificationEmail(email, token);
    } catch (error: unknown) {
      // No token in the log — a live credential in a log file defeats the point
      // of only ever storing its hash.
      this.logger.error(
        `Could not send a verification email to user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Starts a new session: a fresh access token and a new token family. */
  private async issueTokensFor(userId: string): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccessToken(userId),
      this.refreshTokens.issueForNewSession(userId),
    ]);

    return { accessToken, refreshToken };
  }

  /** Identity only — see docs/specs/auth.md on why no role rides along. */
  private signAccessToken(userId: string): Promise<string> {
    return this.jwt.signAsync({ sub: userId });
  }
}
