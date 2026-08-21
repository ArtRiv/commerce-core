import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';

import {
  ApiForbidden,
  ApiUnauthorized,
} from '../../openapi/api-errors.decorator';
import { BEARER_SCHEME } from '../../openapi/security';
import type { Permission } from './permissions';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Gates a route on a capability, and documents that gate in the same call.
 *
 * The metadata half is what `PermissionsGuard` reads. The OpenAPI half exists
 * because the permission is the single most useful thing an API consumer can
 * know about a back-office route and the one thing they cannot discover: a
 * bearer token is visible in the document, but nothing says this particular
 * token needs `orders.refund`, or that only `admin` carries it.
 *
 * Both halves come from one argument list on purpose. Writing the permission
 * a second time — in an @ApiOperation description, or a hand-placed
 * @ApiForbiddenResponse — creates two places to change and therefore a
 * document that is one refactor away from being wrong. Here the guard and the
 * documentation cannot disagree, because they are the same decorator.
 *
 * @example
 *   @RequirePermissions(PERMISSIONS.ORDERS_REFUND)
 *   @Post(':id/refund')
 *   refund(...) { ... }
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  applyDecorators(
    SetMetadata(PERMISSIONS_KEY, permissions),
    ApiBearerAuth(BEARER_SCHEME),
    ApiUnauthorized(),
    ApiForbidden(
      permissions.length === 1
        ? `Authenticated, but the account lacks the \`${permissions[0]}\` permission.`
        : `Authenticated, but the account lacks all of: ${permissions
            .map((permission) => `\`${permission}\``)
            .join(', ')}.`,
    ),
  );
