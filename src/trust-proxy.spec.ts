import type { ConfigService } from '@nestjs/config';

import { resolveTrustProxyHops } from './trust-proxy';

/** A ConfigService that only knows the variables a test hands it. */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('resolveTrustProxyHops', () => {
  it('returns the configured number of hops', () => {
    expect(
      resolveTrustProxyHops(
        configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' }),
      ),
    ).toBe(1);
  });

  it('accepts an explicit 0 in production', () => {
    // "There is no proxy" is a legitimate answer — it just cannot be the
    // implicit one, which is the whole point of the guard below.
    expect(
      resolveTrustProxyHops(
        configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }),
      ),
    ).toBe(0);
  });

  it('accepts more than one hop', () => {
    expect(
      resolveTrustProxyHops(
        configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' }),
      ),
    ).toBe(2);
  });

  it('ignores surrounding whitespace', () => {
    expect(
      resolveTrustProxyHops(
        configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: ' 1 ' }),
      ),
    ).toBe(1);
  });

  describe('when it is not configured', () => {
    it.each(['development', 'test'])('defaults to 0 in %s', (environment) => {
      expect(resolveTrustProxyHops(configWith({ NODE_ENV: environment }))).toBe(
        0,
      );
    });

    it('tolerates casing and whitespace in NODE_ENV', () => {
      expect(
        resolveTrustProxyHops(configWith({ NODE_ENV: ' Development ' })),
      ).toBe(0);
    });

    it.each([
      ['production', 'production'],
      ['staging', 'staging'],
      ['prod', 'prod'],
    ])('refuses to start in %s', (environment) => {
      expect(() =>
        resolveTrustProxyHops(configWith({ NODE_ENV: environment })),
      ).toThrow(/TRUST_PROXY_HOPS is required/);
    });

    it('refuses to start when NODE_ENV is unset', () => {
      // Allow-list, not deny-list — the same asymmetry payments and shipping
      // argue for, and for the same reason: the silent failure is worse than
      // the loud one.
      expect(() => resolveTrustProxyHops(configWith({}))).toThrow(
        /NODE_ENV is unset/,
      );
    });

    it('names the environment it saw', () => {
      expect(() =>
        resolveTrustProxyHops(configWith({ NODE_ENV: 'staging' })),
      ).toThrow(/'staging'/);
    });
  });

  describe('when it is configured with nonsense', () => {
    it.each(['-1', '1.5', 'yes', 'true', 'one', '1e2'])(
      'rejects %s',
      (value) => {
        expect(() =>
          resolveTrustProxyHops(
            configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: value }),
          ),
        ).toThrow(/TRUST_PROXY_HOPS must be/);
      },
    );

    it('names the value it received', () => {
      expect(() =>
        resolveTrustProxyHops(
          configWith({ NODE_ENV: 'production', TRUST_PROXY_HOPS: 'yes' }),
        ),
      ).toThrow(/"yes"/);
    });

    it('rejects nonsense in development too', () => {
      // A value that is present but unparseable is a mistake everywhere. The
      // allow-list only forgives ABSENCE.
      expect(() =>
        resolveTrustProxyHops(
          configWith({ NODE_ENV: 'development', TRUST_PROXY_HOPS: 'yes' }),
        ),
      ).toThrow(/TRUST_PROXY_HOPS must be/);
    });
  });
});
