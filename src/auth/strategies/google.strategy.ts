import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import {
  Profile,
  Strategy,
  type VerifyCallback,
} from 'passport-google-oauth20';

import type { GoogleProfile } from '../auth.service';

/**
 * Whether Google sign-in is configured at all.
 *
 * Social login is optional configuration, unlike the mail provider: an install
 * with no Google credentials is a working app that simply does not offer the
 * button. So this is a check rather than a getOrThrow at boot — otherwise
 * nobody could run the app, or the test suite, without registering an OAuth
 * client first. GoogleOAuthGuard turns the unconfigured case into a clean 503.
 */
export function isGoogleConfigured(config: ConfigService): boolean {
  return (
    !!config.get<string>('GOOGLE_OAUTH_CLIENT_ID') &&
    !!config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET')
  );
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.getOrThrow<string>('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: config.getOrThrow<string>('GOOGLE_OAUTH_CLIENT_SECRET'),
      // API_URL, not APP_URL: this callback is a route on *this service*, where
      // Google sends the browser back with the auth code. APP_URL is the
      // frontend, which is where the emailed links point instead — two
      // different origins, which is why they are two variables.
      callbackURL: `${config.getOrThrow<string>('API_URL')}/auth/google/callback`,
      scope: ['email', 'profile'],
    });
  }

  /**
   * Maps Google's profile onto what AuthService needs, and nothing more.
   *
   * `verified` is carried through rather than assumed. Google returns it per
   * address and it is not always true; AuthService refuses the sign-in without
   * it, because that assertion is the only thing making the auto-link safe.
   *
   * passport-google-oauth20 types `verified` as a boolean but the underlying
   * payload is JSON, where it has historically arrived as the string "true" —
   * so both shapes are accepted rather than trusting the type.
   */
  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const primary = profile.emails?.[0];

    if (!primary) {
      done(new Error('Google returned a profile with no email address'));

      return;
    }

    const verified: unknown = primary.verified;

    const googleProfile: GoogleProfile = {
      googleId: profile.id,
      email: primary.value,
      name: profile.displayName || null,
      emailVerified: verified === true || verified === 'true',
    };

    done(null, googleProfile);
  }
}
