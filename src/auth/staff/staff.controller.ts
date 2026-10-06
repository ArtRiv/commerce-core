import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import {
  ApiBadRequest,
  ApiConflict,
  ApiNotFound,
} from '../../openapi/api-errors.decorator';
import type { AuthenticatedUser } from '../authenticated-user';
import { type Permission, PERMISSIONS } from '../authz/permissions';
import { RequirePermissions } from '../authz/require-permissions.decorator';
import { CurrentUser } from '../current-user.decorator';
import { ChangeRoleDto } from './dto/change-role.dto';
import {
  GrantPermissionDto,
  PERMISSION_KEYS,
} from './dto/grant-permission.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import {
  PaginatedStaffResponse,
  StaffAccountResponse,
} from './responses/staff-account.response';
import { StaffService } from './staff.service';

/** Said once, because all three write routes owe the caller the same warning. */
const IMMEDIATE =
  'Takes effect on the account’s **next request**, with the token it already holds: permissions are resolved from the database on every request rather than baked into the token. Revoking closes the door now, not in fifteen minutes.';

/**
 * Managing who works here (docs/specs/staff-management.md).
 *
 * All four routes are gated on `staff.manage`, which only `admin` holds out of
 * the box and which is itself grantable — the delegation has to be delegable,
 * because the store owner wants a second person doing this work.
 *
 * They answer **403** rather than 404 to a caller without the permission, and
 * that is consistent with the house pattern rather than an exception to it:
 * 404-instead-of-403 hides the *existence of a resource* from whoever probes
 * an id (a DRAFT product, someone else's order). These routes are a
 * capability, not a private resource, and the caller who reaches them already
 * holds full administrative power — there is nothing left to hide from them.
 *
 * 404 still means what it always means, on the two routes that take an id: no
 * such account, no such grant.
 */
@ApiTags('staff')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @Get()
  @ApiOperation({
    summary: 'List the staff accounts',
    description:
      'Everyone with a non-default role, plus anyone holding a per-user grant — the second half matters because a `customer` who was granted a permission is staff by capability whatever their role says.\n\nPlain shoppers are **not** listed. That is not an oversight: a customer directory is personal data and a different surface, reserved behind `customers.read`.\n\nWhich leaves one problem this route has to solve: whoever is about to be promoted is not staff yet. Pass `email` with an exact address to find any account, staff or not — knowing the address is the credential of that use case, and equality matching enumerates nothing. An address with no account is an empty page, not a 404.\n\nEach row separates what the **role** gives from what was **granted** to the person, and reports the union as `effectivePermissions` — which is exactly what the guard will see.',
  })
  @ApiOkResponse({ type: PaginatedStaffResponse })
  @ApiBadRequest(
    '`email` is not an address, or `page`/`perPage` is not an integer above zero.',
  )
  list(@Query() query: ListStaffQueryDto) {
    return this.staff.list(query);
  }

  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @Patch(':userId/role')
  @ApiOperation({
    summary: 'Change an account’s role',
    description: `Moves the account to another role, by name. This is how a shopper becomes an \`operator\`, and how an \`operator\` stops being one.\n\n**Not your own**, ever: a role change adds as easily as it removes — \`operator\` → \`admin\` is this same route — so it is not a decision anybody makes about themselves. Ask another holder of \`staff.manage\`; if you are the only one, that is the store telling you to appoint a second before you step down.\n\nPer-user grants **survive** the change. Demoting an account does not take back what was granted to the person, which is visible in the \`effectivePermissions\` of the response — worth reading before assuming a demotion removed everything.\n\n${IMMEDIATE}`,
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({ type: StaffAccountResponse })
  @ApiBadRequest('No role by that name. The message lists the ones that exist.')
  @ApiConflict(
    'The target is the caller, or the change would leave the store with nobody holding `staff.manage`.',
  )
  @ApiNotFound('No account with that id.')
  changeRole(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.staff.changeRole(caller, userId, dto.role);
  }

  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @Post(':userId/permissions')
  // 200, not Nest's default 201: the response is the account, which already
  // existed, and granting the same permission twice creates nothing at all.
  // Same reading as the order transitions, which POST and answer 200.
  @HttpCode(200)
  @ApiOperation({
    summary: 'Grant a permission to an account',
    description: `One permission on top of the role — the way an \`operator\` hired to catalogue pieces gets \`products.create\` without becoming an \`admin\`.\n\n**You cannot grant to yourself.** That refusal is the reason this route cannot be used to promote the account that is calling it.\n\n**Granting \`staff.manage\` is granting everything.** Not in one step, but in two nobody can prevent: whoever manages access can move an account to \`admin\`, and \`admin\` is the whole catalogue. Delegate it to somebody you would have made an admin.\n\nGranting the same permission twice is a no-op and answers 200; the original \`grantedAt\` and \`grantedById\` stay, because the first grant is the record. Granting one the role already carries is allowed — the grant survives a later role change.\n\n${IMMEDIATE}`,
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiOkResponse({
    type: StaffAccountResponse,
    description: 'The account, with the grant in place. 200 on a repeat too.',
  })
  @ApiBadRequest('`permission` is not a key in the catalogue.')
  @ApiConflict('The target is the caller. Nobody grants themselves anything.')
  @ApiNotFound('No account with that id.')
  grant(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: GrantPermissionDto,
  ) {
    return this.staff.grant(caller, userId, dto.permission);
  }

  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @Delete(':userId/permissions/:permission')
  @ApiOperation({
    summary: 'Revoke a granted permission',
    description: `Removes one **granted** permission. A permission that comes from the role is not here to remove: that is a 404 whose message points at the role, because clicking again would not help.\n\nThis is the one route a caller may aim at themselves, and the asymmetry is deliberate: giving up access is never an escalation, and handing the keys back is a legitimate act. What it may **not** do is leave the store with nobody holding \`staff.manage\` — that is a 409 saying so, because afterwards nobody could grant it to anybody and the only way back would be editing the database.\n\nThe count behind that refusal is of **holders**, not of admins: an \`operator\` carrying the grant administers exactly as much as an \`admin\` does.\n\n${IMMEDIATE}`,
  })
  @ApiParam({ name: 'userId', format: 'uuid' })
  @ApiParam({
    name: 'permission',
    enum: PERMISSION_KEYS,
    description: 'The granted permission to remove, e.g. `products.create`.',
  })
  @ApiOkResponse({
    type: StaffAccountResponse,
    description: 'The account, without that grant.',
  })
  @ApiBadRequest('`permission` is not a key in the catalogue.')
  @ApiConflict(
    'It would remove the last account holding `staff.manage`, leaving nobody able to manage access.',
  )
  @ApiNotFound(
    'No account with that id, or that account has no such **granted** permission — one held through the role is removed by changing the role.',
  )
  revoke(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param(
      'permission',
      new ParseEnumPipe(PERMISSIONS, {
        // The pipe's own message says "enum string is expected" and names
        // nothing, which is useless in a path segment somebody typed.
        exceptionFactory: () =>
          new BadRequestException(
            `Not a permission in the catalogue. Valid keys: ${PERMISSION_KEYS.join(', ')}`,
          ),
      }),
    )
    permission: Permission,
  ) {
    return this.staff.revoke(caller, userId, permission);
  }
}
