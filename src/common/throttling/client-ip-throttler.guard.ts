import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  getOptionsToken,
  getStorageToken,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';

import { clientIpFrom, resolveClientIpHeader } from './client-ip';

/**
 * The IP-keyed throttler guard, keyed on the caller the EDGE reports rather
 * than the one Express infers from a hop count.
 *
 * Use this everywhere `ThrottlerGuard` would otherwise be used. Plain
 * `ThrottlerGuard` keys on `req.ip`, which is not stable behind a CDN whose
 * forwarded chain varies in length — and an unstable key means no limit at
 * all, with nothing in the logs to say so. See client-ip.ts for the full
 * argument and docs/specs/deploy.md for the measurements.
 *
 * With CLIENT_IP_HEADER unset this behaves exactly like ThrottlerGuard, so
 * local development and the e2e suite are untouched.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  /**
   * Resolved once. The value cannot change without a restart, and validating
   * it per request would turn a configuration error into a runtime one — the
   * throw belongs at boot, like every other config guard in this project.
   */
  private readonly clientIpHeader: string | null;

  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.clientIpHeader = resolveClientIpHeader(config);
  }

  protected getTracker(req: Request): Promise<string> {
    return Promise.resolve(clientIpFrom(req, this.clientIpHeader));
  }
}
