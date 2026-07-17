import {
  type ExecutionContext,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { GoogleOAuthGuard } from './google-oauth.guard';
import { isGoogleConfigured } from './strategies/google.strategy';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

const CONFIGURED = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
};

describe('isGoogleConfigured', () => {
  it('is true only when both halves are present', () => {
    expect(isGoogleConfigured(configWith(CONFIGURED))).toBe(true);
    expect(isGoogleConfigured(configWith({}))).toBe(false);
  });

  it('is false when only one half is set', () => {
    // A client id with no secret is a misconfiguration, not a configuration —
    // treating it as enabled would fail later and less clearly.
    expect(
      isGoogleConfigured(configWith({ GOOGLE_OAUTH_CLIENT_ID: 'client-id' })),
    ).toBe(false);
    expect(
      isGoogleConfigured(configWith({ GOOGLE_OAUTH_CLIENT_SECRET: 'secret' })),
    ).toBe(false);
  });

  it('is false for an empty string, not just a missing key', () => {
    // GOOGLE_OAUTH_CLIENT_ID= in a .env file reads as '', which is not configured.
    expect(
      isGoogleConfigured(
        configWith({
          GOOGLE_OAUTH_CLIENT_ID: '',
          GOOGLE_OAUTH_CLIENT_SECRET: '',
        }),
      ),
    ).toBe(false);
  });
});

describe('GoogleOAuthGuard', () => {
  const context = {} as ExecutionContext;

  // Tested here rather than over HTTP on purpose: an e2e assertion about the
  // unconfigured case would pass only while nobody has set the credentials, and
  // would start failing the moment Google sign-in gets turned on. The branch is
  // a function of config, so config is what the test should control.
  it('refuses with 503 when Google sign-in is not configured', () => {
    const guard = new GoogleOAuthGuard(configWith({}));

    expect(() => guard.canActivate(context)).toThrow(
      ServiceUnavailableException,
    );
  });

  // No companion test for the configured case: past the check the guard is
  // passport's, and calling it without a real request drives passport into the
  // request object rather than into this guard's logic — a test about
  // @nestjs/passport, not about this code. The e2e covers the route being live.
});
