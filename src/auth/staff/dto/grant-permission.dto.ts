import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { type Permission, PERMISSIONS } from '../../authz/permissions';

/** The catalogue, as both the validator and the published document see it. */
export const PERMISSION_KEYS = Object.values(PERMISSIONS);

/**
 * One permission, granted on top of whatever the role already gives.
 *
 * The `enum` is the catalogue itself, which makes the OpenAPI document the
 * answer to "which permissions exist?" — there is no route listing them, and
 * with this there does not need to be one.
 */
export class GrantPermissionDto {
  @ApiProperty({
    enum: PERMISSION_KEYS,
    description:
      'The permission to grant. A key outside the catalogue is a 400.\n\nGranting one the role already carries is allowed and is not pointless: a grant **survives a role change**, so the account keeps it after a demotion. Granting `staff.manage` hands over the ability to hand over everything — see the description of this route.',
    example: PERMISSIONS.PRODUCTS_CREATE,
  })
  @IsIn(PERMISSION_KEYS)
  permission: Permission;
}
