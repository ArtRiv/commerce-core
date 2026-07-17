import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService, type RegisteredUser } from './auth.service';
import type { AuthenticatedUser } from './authenticated-user';
import { CurrentUser } from './current-user.decorator';
import { EmailDto } from './dto/email.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { Public } from './public.decorator';
import type { TokenPair } from './token-pair';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<RegisteredUser> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.auth.verifyEmail(dto.token);
  }

  /**
   * Always 204, account or no account. The response cannot depend on whether
   * the address is registered — see docs/security.md.
   */
  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  resendVerification(@Body() dto: EmailDto): Promise<void> {
    return this.auth.resendVerification(dto.email);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto);
  }

  /** Always 204, for the same reason as resend-verification. */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  forgotPassword(@Body() dto: EmailDto): Promise<void> {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  /**
   * Public because the refresh token *is* the credential here — the caller's
   * access token has usually expired by the time they need this.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
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
  logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RefreshTokenDto,
  ): Promise<void> {
    return this.auth.logout(user.id, dto.refreshToken);
  }
}
