import { type ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

/**
 * Authenticates the request if — and only if — it offers credentials.
 *
 * For routes that are public but privilege-aware: the catalog's read routes
 * serve anyone, yet answer differently to a caller holding products.read
 * (drafts become visible). The global JwtAuthGuard can't express that — it
 * either demands a token or, on `@Public()`, ignores one entirely.
 *
 * Semantics: no Authorization header → anonymous, pass. Header present →
 * full validation, and a bad token is a 401, not silent anonymity. A caller
 * who offered credentials deserves to know they were rejected; quietly
 * downgrading an expired session to "anonymous" would turn it into a
 * baffling 403/404 two requests later.
 *
 * Use together with `@Public()` (so the global guard steps aside) and
 * `@CurrentUser()` (which yields undefined for the anonymous case).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.headers.authorization) {
      return true;
    }

    return super.canActivate(context);
  }
}
