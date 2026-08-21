import { applyDecorators } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import { ApiUnauthorized } from './api-errors.decorator';

/**
 * The name the bearer scheme is registered under in the document. Shared so
 * that the DocumentBuilder and every @ApiBearerAuth() agree — a typo here
 * produces an operation referencing a scheme that does not exist, which
 * generators silently render as "no auth".
 */
export const BEARER_SCHEME = 'bearer';

/**
 * Marks a route as needing a valid access token and nothing more.
 *
 * For the routes the global JwtAuthGuard protects but no permission gates:
 * the whole cart, checkout, a customer's own orders. Authorization there is
 * ownership, not capability — the service scopes every query to the caller —
 * so there is no permission to name, only a token to require.
 *
 * Routes that DO need a permission use @RequirePermissions instead, which
 * emits this and the 403 in one call.
 */
export const ApiAuthenticated = () =>
  applyDecorators(ApiBearerAuth(BEARER_SCHEME), ApiUnauthorized());
