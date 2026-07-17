import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

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
 */
@Injectable()
export class EmailThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Request): Promise<string> {
    const body: unknown = req.body;
    const email =
      typeof body === 'object' && body !== null && 'email' in body
        ? body.email
        : undefined;

    // Normalized the same way AuthService does, or "Ada@example.com" and
    // "ada@example.com" would get a budget each for the one account.
    if (typeof email === 'string' && email.length > 0) {
      return Promise.resolve(`email:${email.trim().toLowerCase()}`);
    }

    // No email in the body means validation is about to reject this anyway;
    // fall back to the IP so the request still costs the caller something.
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }
}
