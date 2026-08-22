import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { ClientIpThrottlerGuard } from '../common/throttling/client-ip-throttler.guard';
import {
  ApiBadRequest,
  ApiConflict,
  ApiRateLimited,
  ApiServiceUnavailable,
  ApiUnauthorized,
} from '../openapi/api-errors.decorator';
import { ApiAuthenticated } from '../openapi/security';
import {
  AuthService,
  type GoogleProfile,
  type RegisteredUser,
} from './auth.service';
import type { AuthenticatedUser } from './authenticated-user';
import { CurrentUser } from './current-user.decorator';
import { EmailDto } from './dto/email.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { GoogleOAuthGuard } from './google-oauth.guard';
import { Public } from './public.decorator';
import { RegisteredUserResponse } from './responses/registered-user.response';
import { TokenPairResponse } from './responses/token-pair.response';
import { EmailThrottlerGuard } from './throttling/email-throttler.guard';
import { RATE_LIMITS } from './throttling/rate-limits';
import type { TokenPair } from './token-pair';

/**
 * The 204s here are load-bearing, not laziness — see the anti-enumeration
 * note on resendVerification. Documenting them as "no content" without saying
 * why invites a frontend to build the very "no such account" screen the API
 * refuses to feed.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.REGISTER })
  @Post('register')
  @ApiOperation({
    summary: 'Create an account',
    description:
      'Creates an unverified account and sends the verification e-mail. This does NOT sign anyone in: password login stays closed until the e-mailed link is followed, so there is no token in the response.\n\nRegistering again with an address that exists but was never verified is treated as "I forgot I already did this" — the link is resent and no second account appears. The new account always gets the default role (`customer`); roles are never chosen by the registrant.\n\nIf the mail provider is down the account is still created, and the caller can ask for a resend later — e-mail delivery does not block registration.',
  })
  @ApiCreatedResponse({ type: RegisteredUserResponse })
  @ApiBadRequest(
    'Invalid e-mail, or a password outside 8–128 characters. There are no composition rules (docs/security.md).',
  )
  @ApiConflict('That address already belongs to a verified account.')
  @ApiRateLimited(RATE_LIMITS.REGISTER.limit, 'hour, per IP')
  register(@Body() dto: RegisterDto): Promise<RegisteredUser> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Confirm an e-mail address',
    description:
      'Consumes the token from the verification e-mail, which is what unlocks password login. Tokens are single-use and expire after 24 hours.',
  })
  @ApiNoContentResponse({ description: 'The address is now verified.' })
  @ApiBadRequest('The token is missing, malformed, expired, or already used.')
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.auth.verifyEmail(dto.token);
  }

  /**
   * Always 204, account or no account. The response cannot depend on whether
   * the address is registered — see docs/security.md.
   */
  @Public()
  @UseGuards(EmailThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.EMAIL_DISPATCH })
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Resend the verification e-mail',
    description:
      '**Always answers 204, whether or not the address has an account** — and whether or not it was already verified. That is deliberate: a response that varied would turn this endpoint into an oracle for which addresses are registered (docs/security.md). Do not build a "no such account" state on this route; the API will never report one.\n\nThe rate limit is low and keyed by e-mail rather than IP, because the abuse here is not against this API — it is using its sending reputation to flood a stranger\'s inbox.',
  })
  @ApiNoContentResponse({
    description: 'Accepted. An e-mail may or may not have been sent.',
  })
  @ApiBadRequest('The value is not a well-formed e-mail address.')
  @ApiRateLimited(RATE_LIMITS.EMAIL_DISPATCH.limit, 'hour, per e-mail address')
  resendVerification(@Body() dto: EmailDto): Promise<void> {
    return this.auth.resendVerification(dto.email);
  }

  @Public()
  @UseGuards(ClientIpThrottlerGuard, EmailThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.LOGIN })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with e-mail and password',
    description:
      'Requires a verified address. A wrong e-mail and a wrong password produce the identical 401 — the response never reveals which half was wrong, nor whether the account exists, nor that an account is Google-only and has no password at all.\n\nThe rate limit applies per IP **and** per account: limiting only by IP hands an attacker with a proxy pool a fresh budget per address while punishing an office behind one NAT.',
  })
  @ApiOkResponse({ type: TokenPairResponse })
  @ApiBadRequest('Malformed e-mail, or a password over 128 characters.')
  @ApiUnauthorized(
    'Wrong credentials, or the address has not been verified yet. The message does not distinguish the cases.',
  )
  @ApiRateLimited(RATE_LIMITS.LOGIN.limit, '15 minutes, per IP and per account')
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto);
  }

  /** Always 204, for the same reason as resend-verification. */
  @Public()
  @UseGuards(EmailThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.EMAIL_DISPATCH })
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Start a password reset',
    description:
      '**Always answers 204, whether or not the address has an account** — same anti-enumeration rule as resend-verification, and the same warning: there is no "unknown e-mail" response to render.\n\nAn account that only ever signed in with Google gets the same 204 and no e-mail, since it has no password to reset.',
  })
  @ApiNoContentResponse({
    description: 'Accepted. An e-mail may or may not have been sent.',
  })
  @ApiBadRequest('The value is not a well-formed e-mail address.')
  @ApiRateLimited(RATE_LIMITS.EMAIL_DISPATCH.limit, 'hour, per e-mail address')
  forgotPassword(@Body() dto: EmailDto): Promise<void> {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Finish a password reset',
    description:
      'Sets a new password from the token in the reset e-mail. Tokens are single-use and expire after 1 hour.\n\nTwo side effects worth knowing. Every existing session is revoked — not just the current one — because a password change is exactly when "sign me out everywhere" is the right default. And the address is marked verified if it was not already: reaching a reset token proves possession of the mailbox, which is the same proof the verification e-mail asks for.',
  })
  @ApiNoContentResponse({
    description: 'Password changed, and every prior session revoked.',
  })
  @ApiBadRequest(
    'The token is missing, expired or already used, or the new password is outside 8–128 characters.',
  )
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  /**
   * Kicks off the OAuth flow. The guard redirects to Google; this handler is
   * never actually entered.
   */
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google')
  @ApiOperation({
    summary: 'Start the Google sign-in flow',
    description:
      'Redirects to Google. Open it in a browser — this is not an XHR endpoint, and it never returns a body of its own.\n\nGoogle sign-in is optional configuration: where the deployment has no Google credentials, this answers 503 rather than pretending the route does not exist.',
  })
  @ApiOkResponse({ description: 'Redirects (302) to Google.' })
  @ApiServiceUnavailable('Google sign-in is not configured on this deployment.')
  google(): void {
    // Intentionally empty.
  }

  /**
   * Where Google sends the user back. The guard has already exchanged the code
   * and run GoogleStrategy.validate by the time this runs, so `user` is the
   * profile it produced — not an AuthenticatedUser.
   */
  @Public()
  @UseGuards(GoogleOAuthGuard)
  @Get('google/callback')
  @ApiOperation({
    summary: 'Google OAuth callback',
    description:
      "Where Google returns the user. Called by the browser, not by application code — the redirect URI registered with Google must match this URL exactly.\n\nAn account is created on first sign-in, already verified. If the address already has an account it is linked rather than duplicated, matching on Google's subject id first and the address second. Linking only happens when Google asserts `email_verified`: that assertion is what replaces our own verification e-mail, and without it the sign-in is refused.",
  })
  @ApiOkResponse({ type: TokenPairResponse })
  @ApiUnauthorized(
    'Consent was denied, the exchange failed, or Google did not vouch for the address.',
  )
  @ApiServiceUnavailable('Google sign-in is not configured on this deployment.')
  googleCallback(@Req() req: Request): Promise<TokenPair> {
    return this.auth.loginWithGoogle(req.user as GoogleProfile);
  }

  /**
   * Public because the refresh token *is* the credential here — the caller's
   * access token has usually expired by the time they need this.
   */
  @Public()
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: RATE_LIMITS.REFRESH })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a refresh token for a new pair',
    description:
      'No bearer token needed: the refresh token **is** the credential, and the access token has usually expired by the time a client needs this.\n\nRefresh tokens are single-use. Each call returns a new pair and retires the one presented. Re-presenting a spent token is read as theft and revokes the whole session family, so a client must never issue two refreshes concurrently with the same token.\n\nThe limit here is generous because it is anti-flood, not anti-guessing — a refresh token is 256 bits of randomness stored as a hash, so there is nothing to brute-force.',
  })
  @ApiOkResponse({ type: TokenPairResponse })
  @ApiBadRequest('The refresh token is missing or empty.')
  @ApiUnauthorized(
    'The token is unknown, expired, already used, or belongs to a revoked family.',
  )
  @ApiRateLimited(RATE_LIMITS.REFRESH.limit, 'minute, per IP')
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * Authenticated *and* takes the refresh token: the access token says who is
   * asking, the refresh token says which session to end. Without the latter we
   * could only revoke every session the user has.
   */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiAuthenticated()
  @ApiOperation({
    summary: 'End the current session',
    description:
      'Takes the refresh token in the body **as well as** the access token in the header, and both are needed. The access token carries only a user id, so on its own it cannot say which session to end — revoking on that alone would sign the user out of every device, which is a different feature.\n\nThe refresh token presented must belong to the authenticated caller. Only that session family is revoked; the access token is stateless and simply expires on its own within 15 minutes.',
  })
  @ApiNoContentResponse({ description: 'That session family is revoked.' })
  @ApiBadRequest('The refresh token is missing or empty.')
  logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RefreshTokenDto,
  ): Promise<void> {
    return this.auth.logout(user.id, dto.refreshToken);
  }
}
