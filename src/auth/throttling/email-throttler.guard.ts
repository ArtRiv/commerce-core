import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { ClientIpThrottlerGuard } from '../../common/throttling/client-ip-throttler.guard';

/**
 * Rate limits by the email in the request body instead of the caller's IP.
 *
 * IP alone is the wrong key for credential and mail-sending endpoints. An
 * attacker rotating through a proxy pool gets a fresh budget per address, while
 * a shared office NAT burns one budget between everybody. Keying on the account
 * being targeted follows the thing worth protecting rather than the thing that
 * happens to be sending packets.
 *
 * Used alongside the IP-keyed guard, not instead of it: per-IP catches one
 * source spraying many accounts, per-email catches many sources hammering one.
 *
 * Extends ClientIpThrottlerGuard rather than ThrottlerGuard so the fallback
 * below resolves the caller the same way the IP-keyed guard does. Inheriting
 * the plain guard would have left this one path still keyed on `req.ip`, which
 * is exactly the value that turned out not to be stable behind Render's edge
 * (see common/throttling/client-ip.ts).
 */
@Injectable()
export class EmailThrottlerGuard extends ClientIpThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    const body: unknown = req.body;
    const email =
      typeof body === 'object' && body !== null && 'email' in body
        ? body.email
        : undefined;

    // Normalized the same way AuthService does, or "Ada@example.com" and
    // "ada@example.com" would get a budget each for the one account.
    if (typeof email === 'string' && email.length > 0) {
      return `email:${email.trim().toLowerCase()}`;
    }

    // No email in the body means validation is about to reject this anyway;
    // fall back to the caller so the request still costs them something.
    return `ip:${await super.getTracker(req)}`;
  }
}
