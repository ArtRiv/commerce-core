import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Which caller a rate limit is counting.
 *
 * `req.ip` is the natural answer and it is the wrong one behind a CDN. Express
 * derives it by walking a fixed number of proxy hops back through
 * `X-Forwarded-For` (see trust-proxy.ts), which assumes the chain has a
 * constant length. On Render it does not: traffic passes through Cloudflare's
 * edge and then Render's load balancer, and probing the deployed service showed
 * the number of appended entries varying from request to request. The
 * consequence is not a subtle inaccuracy — every request lands in a different
 * bucket, so the IP-keyed limits never trigger at all, silently.
 *
 * The fix is to stop counting and read a header the edge itself writes.
 * Cloudflare SETS `CF-Connecting-IP` from the connecting socket and overwrites
 * whatever the client sent, so it cannot be forged from outside; Render's
 * origin is only reachable through that edge. Naming the header in
 * configuration rather than hard-coding it keeps this platform-neutral: unset,
 * nothing changes and `req.ip` still decides.
 */

/** Header names are ASCII tokens; anything else is a typo, not a header. */
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

export function resolveClientIpHeader(config: ConfigService): string | null {
  const raw = config.get<string>('CLIENT_IP_HEADER')?.trim();

  if (!raw) {
    return null;
  }

  // Node lowercases incoming header keys, so the lookup has to be lowercase
  // regardless of how the variable was written.
  const name = raw.toLowerCase();

  if (!HEADER_NAME.test(name)) {
    throw new Error(
      `CLIENT_IP_HEADER must be a header name (got ${JSON.stringify(raw)}).`,
    );
  }

  return name;
}

export function clientIpFrom(req: Request, headerName: string | null): string {
  if (headerName) {
    const raw = req.headers[headerName];
    const value = Array.isArray(raw) ? raw[0] : raw;
    // CF-Connecting-IP is a single address, but splitting is free and keeps
    // this correct for any header that ever carries a list.
    const first = value?.split(',')[0]?.trim();

    if (first) {
      return first;
    }
  }

  // The header is absent — a request that reached the origin without passing
  // the edge that writes it. Falling back to req.ip is deliberate: the
  // alternative, a single shared key, would rate-limit every such caller
  // together, which is a denial of service wearing a security hat.
  return req.ip ?? 'unknown';
}
