import {
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';

import { isGoogleConfigured } from './strategies/google.strategy';

/**
 * Runs the Google OAuth flow, refusing cleanly when it is not configured.
 *
 * Without the check, an install with no Google credentials never registers the
 * passport strategy, and these routes would fail with an "Unknown
 * authentication strategy" 500 — an internal error for what is really a
 * deployment choice. A 503 says the truth: this works, it is just not turned on
 * here.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (!isGoogleConfigured(this.config)) {
      throw new ServiceUnavailableException('Google sign-in is not configured');
    }

    return super.canActivate(context);
  }
}
