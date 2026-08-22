import type { ConfigService } from '@nestjs/config';

/**
 * How many reverse proxies sit between the internet and this process.
 *
 * Express turns this into `req.ip`, and `req.ip` is what @nestjs/throttler
 * keys every rate limit on — so this number decides whether the limits in
 * docs/security.md apply per caller or to the whole world at once. Both ways
 * of getting it wrong are silent:
 *
 *   too low  — behind a load balancer, `req.ip` is the balancer. Every caller
 *              shares one bucket, so the ten-a-minute login limit is ten a
 *              minute for the entire internet, and one bored client locks
 *              everyone out.
 *   too high — Express walks further left into `X-Forwarded-For` than there
 *              are trusted hops, and lands on a value the CLIENT wrote. A
 *              fresh bucket is then one header away, which is worse than
 *              having no limit at all, because the dashboard still shows one.
 *
 * Neither shows up in a log line or a failing test; both need someone to have
 * thought about the topology. Hence a required, explicit number rather than a
 * default that is right on a laptop and wrong in front of a proxy.
 */

/**
 * Environments where "no proxy" is a safe assumption rather than a guess —
 * the same allow-list, for the same reason, as resolvePaymentProvider and
 * resolveShippingTable. Anything else, NODE_ENV being unset included, is
 * treated as real.
 */
const IMPLICIT_ZERO_ALLOWED = new Set(['development', 'test']);

export function resolveTrustProxyHops(config: ConfigService): number {
  const raw = config.get<string>('TRUST_PROXY_HOPS')?.trim();

  if (raw) {
    // Deliberately stricter than Number(): '1e2', '0x1' and ' 1 ' all parse as
    // numbers, and none of them is something a person meant to write in a hop
    // count. A digit string is the only shape that is unambiguous.
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `TRUST_PROXY_HOPS must be a whole number of proxy hops, 0 or more (got ${JSON.stringify(raw)}).`,
      );
    }

    return Number(raw);
  }

  const environment = config.get<string>('NODE_ENV')?.trim().toLowerCase();

  if (!environment || !IMPLICIT_ZERO_ALLOWED.has(environment)) {
    throw new Error(
      "TRUST_PROXY_HOPS is required unless NODE_ENV is 'development' or 'test' " +
        `(NODE_ENV is ${environment ? `'${environment}'` : 'unset'}) — refusing to start a ` +
        'store whose rate limits either count the whole internet as one caller or trust a ' +
        'header the caller writes. Set it to the number of proxies in front of this process ' +
        '(1 behind a single load balancer, 0 if it is exposed directly).',
    );
  }

  // No warning, unlike the payments and shipping fallbacks. Those substitute a
  // fake for the real thing; this one is not a substitute. On localhost there
  // IS no proxy, so 0 is the correct answer rather than a degraded one, and a
  // warning on every dev boot would train people to ignore warnings.
  return 0;
}
