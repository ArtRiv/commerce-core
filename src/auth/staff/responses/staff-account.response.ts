import { ApiProperty } from '@nestjs/swagger';

import { PERMISSIONS } from '../../authz/permissions';

/** One per-user grant, with the provenance the schema always stored. */
export class StaffGrantResponse {
  @ApiProperty({
    description: 'The permission key, from the catalogue.',
    example: PERMISSIONS.PRODUCTS_CREATE,
  })
  permission: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When it was granted. Granting the same permission again is a no-op and leaves this at the first grant — the original act is the fact worth keeping.',
  })
  grantedAt: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Who granted it. Null when that account no longer exists: the grant outlives the granter, because leaving does not take back the access you gave.\n\nAn id rather than an address — the granter is staff and therefore in this same listing, so a panel resolves the name without this route copying e-mail addresses inside other objects.',
  })
  grantedById: string | null;
}

/**
 * A staff account, written column by column.
 *
 * `User` carries `passwordHash` and `googleId`, and a response built by spread
 * is exactly how a back-office listing hands out every password hash
 * (docs/admin-api.md). Every field here was added on purpose, and the e2e
 * suite fails if either of those names ever appears in a body.
 */
export class StaffAccountResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email', example: 'joana@example.com' })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null on an account created through Google that never set one.',
    example: 'Joana',
  })
  name: string | null;

  @ApiProperty({
    description: 'Role name. Change it with `PATCH /staff/{userId}/role`.',
    example: 'operator',
  })
  role: string;

  @ApiProperty({
    type: [String],
    description:
      'What the **role** grants. Not revocable here: these move when the role moves.',
    example: [PERMISSIONS.PRODUCTS_READ, PERMISSIONS.ORDERS_READ],
  })
  rolePermissions: string[];

  @ApiProperty({
    type: [StaffGrantResponse],
    description:
      'Grants made to this account on top of its role, oldest first. These are the ones `DELETE /staff/{userId}/permissions/{permission}` removes.',
  })
  directPermissions: StaffGrantResponse[];

  @ApiProperty({
    type: [String],
    description:
      'The union of the two above — **what the guard will actually see on the next request**, resolved by the same function the token strategy uses. A key that is no longer in the catalogue appears in `directPermissions` and not here, because it grants nothing.',
    example: [PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_READ],
  })
  effectivePermissions: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Null on an account that has not proven its address yet. It does not affect authorization — verification gates password login, so an unverified account simply cannot sign in to use what it was granted.',
  })
  emailVerifiedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

export class PaginatedStaffResponse {
  @ApiProperty({
    type: [StaffAccountResponse],
    description: 'Ordered by e-mail, ascending.',
  })
  items: StaffAccountResponse[];

  @ApiProperty({
    description: 'Accounts matching the filter, not the page size.',
    example: 3,
  })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ description: 'Clamped to 100.', example: 20 })
  perPage: number;
}
