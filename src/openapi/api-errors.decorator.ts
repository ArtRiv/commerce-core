import { ApiResponse } from '@nestjs/swagger';

import { ErrorResponse } from './error.response';

/**
 * One decorator per status code in the project's error convention, so that
 * documenting a failure is a single call that already knows the body shape.
 *
 * The convention itself is not invented here — orders.md, payments.md and
 * shipping.md each state it, and they agree:
 *
 *   400  malformed input
 *   401  no token (or a token that was offered and rejected)
 *   403  authenticated, but lacking the permission
 *   404  does not exist *or* belongs to someone else — the two are
 *        deliberately indistinguishable (docs/specs/orders.md)
 *   409  a valid request that conflicts with current state
 *   429  rate limited
 *   503  a provider this route depends on is unreachable
 *
 * These are applied where the specs say the failure happens, never in a
 * blanket block: a 409 on a read route or a 404 on /auth/login would be
 * documentation that lies, and a lying document is worse than a thin one.
 * 401 and 403 are the exception — they come from @RequirePermissions, because
 * the guard and the doc should be the same decorator call.
 */

const describe = (status: number, description: string) =>
  ApiResponse({ status, description, type: ErrorResponse });

export const ApiBadRequest = (
  description = 'The request body or query string failed validation.',
) => describe(400, description);

export const ApiUnauthorized = (
  description = 'No bearer token, or the token is expired or invalid.',
) => describe(401, description);

export const ApiForbidden = (description: string) => describe(403, description);

export const ApiNotFound = (description: string) => describe(404, description);

export const ApiConflict = (description: string) => describe(409, description);

/**
 * Carries the limit into the description because a rate limit nobody can see
 * is a rate limit clients discover by tripping it. `Retry-After` is on the
 * response (docs/security.md), so it is documented as a header rather than
 * left for the caller to guess at.
 */
export const ApiRateLimited = (limit: number, window: string) =>
  ApiResponse({
    status: 429,
    description: `Rate limit exceeded — this route allows ${String(limit)} requests per ${window}.`,
    type: ErrorResponse,
    headers: {
      'Retry-After': {
        description: 'Seconds to wait before retrying.',
        schema: { type: 'integer' },
      },
    },
  });

export const ApiServiceUnavailable = (description: string) =>
  describe(503, description);
