import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../authenticated-user';
import { type Permission, PERMISSIONS } from '../authz/permissions';
import { resolveEffectivePermissions } from '../authz/role-permissions';
import { normalizeEmail } from '../normalize-email';

const MAX_PER_PAGE = 100;

/**
 * The account, column by column.
 *
 * Written out rather than a bare `include`, for the reason docs/admin-api.md
 * spells out as a live hazard: `User` carries `passwordHash` and `googleId`,
 * and a generic read is how a back-office listing hands every password hash to
 * the client. Adding a column here is a decision somebody has to make on
 * purpose.
 */
const ACCOUNT_SELECT = {
  id: true,
  email: true,
  name: true,
  emailVerifiedAt: true,
  createdAt: true,
  role: {
    select: {
      name: true,
      permissions: { select: { permission: { select: { key: true } } } },
    },
  },
  permissionsGrantedToUser: {
    select: {
      grantedAt: true,
      grantedById: true,
      permission: { select: { key: true } },
    },
    // Oldest first: the order in which access was handed out is the order in
    // which somebody reading the provenance wants to see it.
    orderBy: { grantedAt: 'asc' },
  },
} as const;

/** Shape of the rows ACCOUNT_SELECT produces, so mapping needs no `any`. */
interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  role: { name: string; permissions: { permission: { key: string } }[] };
  permissionsGrantedToUser: {
    grantedAt: Date;
    grantedById: string | null;
    permission: { key: string };
  }[];
}

export interface ListStaffInput {
  /** Exact match, and the only way a plain customer appears. */
  email?: string;
  page?: number;
  perPage?: number;
}

export interface StaffGrant {
  permission: string;
  grantedAt: Date;
  /** Null once the granter's account is gone — the grant outlives them. */
  grantedById: string | null;
}

export interface StaffAccount {
  id: string;
  email: string;
  name: string | null;
  role: string;
  rolePermissions: string[];
  directPermissions: StaffGrant[];
  effectivePermissions: string[];
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export interface PaginatedStaff {
  items: StaffAccount[];
  total: number;
  page: number;
  perPage: number;
}

const SELF_GRANT =
  'You cannot grant yourself a permission. Ask another holder of staff.manage to do it.';

const SELF_ROLE =
  'You cannot change your own role. A role change adds as easily as it removes, so it is not yours to make about yourself — ask another holder of staff.manage.';

const LAST_HOLDER =
  'Refused: this would remove the last account able to manage access. Nobody could grant staff.manage to anybody afterwards, and the store would be back to editing the database by hand. Give staff.manage to another account first.';

/**
 * One message for both shapes of the miss — the account never had the grant,
 * or it holds the permission through its role — because from the caller's side
 * they are the same fact ("there is no grant here to remove") and the useful
 * half is the same too: a role's permissions do not come off one at a time.
 */
function noSuchGrantMessage(permission: string): string {
  return `This account has no direct grant of ${permission}. If it holds that permission through its role, change the role instead — a role's permissions are not revoked one by one.`;
}

/**
 * Managing who works here (docs/specs/staff-management.md).
 *
 * Lives inside `auth` rather than in a module of its own because `users`,
 * `roles`, `role_permissions` and `user_permissions` are auth's tables. A
 * separate module would have to read AND write them directly, which would be a
 * second exception to the boundary rule in docs/architecture/modules.md — and,
 * unlike the reports one, an exception with writes behind it.
 *
 * Three refusals carry the whole design, and they are the reason this file is
 * longer than the four queries it runs:
 *
 *  1. nobody gives themselves anything (`grant`, `changeRole`);
 *  2. renouncing is allowed, which is what makes (3) reachable at all;
 *  3. the store never runs out of accounts holding `staff.manage`, counted
 *     over effective holders — role permissions ∪ per-user grants — rather
 *     than over who has the `admin` role.
 */
@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The team, or one exact address.
   *
   * Without `email`, the recorte is "not the default role, or at least one
   * direct grant" — position, not a non-empty permission set, so an account
   * cannot vanish from the screen that manages it just because its role was
   * emptied. With `email`, the recorte is bypassed on an equality match:
   * whoever is about to be promoted is not staff yet, and knowing the address
   * is the credential of that use case. Substring search would be enumeration
   * and deliberately does not exist.
   */
  async list(input: ListStaffInput): Promise<PaginatedStaff> {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const perPage = Math.min(
      MAX_PER_PAGE,
      Math.max(1, Math.trunc(input.perPage ?? 20)),
    );

    const where: Prisma.UserWhereInput = input.email
      ? { email: normalizeEmail(input.email) }
      : {
          OR: [
            { role: { isDefault: false } },
            { permissionsGrantedToUser: { some: {} } },
          ],
        };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: ACCOUNT_SELECT,
        // Unique, so the page is stable without a tiebreaker, and it is the
        // order a person scans a list of colleagues in.
        orderBy: { email: 'asc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: (rows as AccountRow[]).map(toStaffAccount),
      total,
      page,
      perPage,
    };
  }

  /**
   * Moves an account to another role.
   *
   * Never the caller's own: a role is not ordered, so "change my role" is as
   * much a promotion as a demotion, and the caller is exactly the person who
   * should not be deciding that about themselves.
   */
  async changeRole(
    caller: AuthenticatedUser,
    userId: string,
    roleName: string,
  ): Promise<StaffAccount> {
    if (userId === caller.id) {
      throw new ConflictException(SELF_ROLE);
    }

    const role = await this.requireRole(roleName);

    await this.prisma.$transaction(async (tx) => {
      const holders = await this.lockHolders(tx);
      const account = await this.readAccount(tx, userId);

      // The grants survive a role change — that is what makes them grants —
      // so the permission can outlive the role that also carried it.
      assertStoreKeepsAnAdministrator(
        holders,
        userId,
        resolveEffectivePermissions(
          role.permissions.map((rp) => rp.permission.key),
          account.permissionsGrantedToUser.map((up) => up.permission.key),
        ),
      );

      await tx.user.update({
        where: { id: userId },
        data: { roleId: role.id },
      });
    });

    return this.account(userId);
  }

  /**
   * Grants one permission on top of the role.
   *
   * Idempotent, and the repeat deliberately does not refresh `grantedAt` or
   * `grantedById`: the first grant is the fact, and it is the only audit trail
   * this feature has.
   */
  async grant(
    caller: AuthenticatedUser,
    userId: string,
    permission: Permission,
  ): Promise<StaffAccount> {
    if (userId === caller.id) {
      throw new ConflictException(SELF_GRANT);
    }

    const permissionId = await this.requirePermissionRow(permission);

    await this.prisma.$transaction(async (tx) => {
      await this.readAccount(tx, userId);

      await tx.userPermission.upsert({
        where: { userId_permissionId: { userId, permissionId } },
        create: { userId, permissionId, grantedById: caller.id },
        update: {},
      });
    });

    return this.account(userId);
  }

  /**
   * Removes one per-user grant — never a permission that comes from the role.
   *
   * This is the one operation a caller may aim at themselves. Renouncing is
   * never an escalation: the caller's own set only shrinks, and handing the
   * keys back is a legitimate act. It is also the only path that can reach the
   * last-holder guard, and a guard nobody can reach is a guard nobody tests.
   */
  async revoke(
    caller: AuthenticatedUser,
    userId: string,
    permission: Permission,
  ): Promise<StaffAccount> {
    const permissionId = await this.requirePermissionRow(permission);

    await this.prisma.$transaction(async (tx) => {
      const holders = await this.lockHolders(tx);
      const account = await this.readAccount(tx, userId);

      const granted = account.permissionsGrantedToUser.map(
        (up) => up.permission.key,
      );

      if (!granted.includes(permission)) {
        throw new NotFoundException(noSuchGrantMessage(permission));
      }

      assertStoreKeepsAnAdministrator(
        holders,
        userId,
        resolveEffectivePermissions(
          account.role.permissions.map((rp) => rp.permission.key),
          granted.filter((key) => key !== permission),
        ),
      );

      await tx.userPermission.delete({
        where: { userId_permissionId: { userId, permissionId } },
      });
    });

    return this.account(userId);
  }

  /**
   * Every account holding `staff.manage`, locked, in a fixed order.
   *
   * The two EXISTS clauses are the whole of invariant 1: a holder is whoever
   * the `jwt.strategy` would resolve the permission for, which is the role's
   * permissions united with the per-user grants. Counting `admin` roles
   * instead would miss the operator carrying the grant, and would protect a
   * role nobody needs to hold.
   *
   * `FOR UPDATE` is taken BEFORE any write in the transaction, and the rows
   * come back `ORDER BY id`, for the reason the variant removal already
   * documents: two operations racing take the same rows in the same order, so
   * they queue instead of deadlocking. Without the lock, two holders
   * renouncing at once each read "somebody else is still here" and both
   * commit — the store ends with zero administrators and two 200s.
   */
  private async lockHolders(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT u."id"
      FROM "users" u
      WHERE EXISTS (
              SELECT 1
              FROM "role_permissions" rp
              JOIN "permissions" p ON p."id" = rp."permission_id"
              WHERE rp."role_id" = u."role_id"
                AND p."key" = ${PERMISSIONS.STAFF_MANAGE}
            )
         OR EXISTS (
              SELECT 1
              FROM "user_permissions" up
              JOIN "permissions" p ON p."id" = up."permission_id"
              WHERE up."user_id" = u."id"
                AND p."key" = ${PERMISSIONS.STAFF_MANAGE}
            )
      ORDER BY u."id"
      FOR UPDATE OF u
    `;

    return rows.map((row) => row.id);
  }

  private async readAccount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<AccountRow> {
    const account = await tx.user.findUnique({
      where: { id: userId },
      select: ACCOUNT_SELECT,
    });

    if (!account) {
      throw new NotFoundException('No account with that id');
    }

    return account;
  }

  /** The account as the API returns it, read back after the write. */
  private async account(userId: string): Promise<StaffAccount> {
    return toStaffAccount(await this.readAccount(this.prisma, userId));
  }

  private async requireRole(name: string) {
    const role = await this.prisma.role.findUnique({
      where: { name },
      select: {
        id: true,
        name: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    });

    if (role) {
      return role;
    }

    // 400 rather than 404, and the difference is what the answer can say: a
    // role here is a value from a small closed vocabulary, not a resource the
    // caller may or may not be allowed to see, so the refusal can name the
    // ones that exist. A 404 could not.
    const known = await this.prisma.role.findMany({
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    throw new BadRequestException(
      `Unknown role "${name}". Valid roles: ${known
        .map((row) => row.name)
        .join(', ')}`,
    );
  }

  private async requirePermissionRow(permission: Permission): Promise<string> {
    const row = await this.prisma.permission.findUnique({
      where: { key: permission },
      select: { id: true },
    });

    if (!row) {
      // The DTO already checked the key against the code catalogue, so this is
      // the database disagreeing with the code — an unseeded deploy. Loud,
      // because the alternative is a foreign key violation surfacing as a 500
      // with nothing in it that names the cause.
      throw new InternalServerErrorException(
        `The permission catalogue is missing "${permission}". Run \`prisma db seed\`.`,
      );
    }

    return row.id;
  }
}

/**
 * Refuses an operation that would leave nobody able to manage access.
 *
 * `holders` is the locked set from before the write; `effectiveAfter` is what
 * the target would hold once it lands. The refusal fires only when the target
 * is a holder now, is not one afterwards, and is the only one — which is why
 * granting, or a demotion whose direct grant survives, never trips it.
 */
function assertStoreKeepsAnAdministrator(
  holders: readonly string[],
  targetId: string,
  effectiveAfter: ReadonlySet<Permission>,
): void {
  if (effectiveAfter.has(PERMISSIONS.STAFF_MANAGE)) {
    return;
  }

  if (!holders.includes(targetId)) {
    return;
  }

  if (holders.some((id) => id !== targetId)) {
    return;
  }

  throw new ConflictException(LAST_HOLDER);
}

function toStaffAccount(row: AccountRow): StaffAccount {
  const rolePermissions = row.role.permissions.map((rp) => rp.permission.key);
  const directPermissions = row.permissionsGrantedToUser.map((up) => ({
    permission: up.permission.key,
    grantedAt: up.grantedAt,
    grantedById: up.grantedById,
  }));

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role.name,
    rolePermissions: [...rolePermissions].sort(),
    directPermissions,
    // The same function the jwt.strategy calls, so the screen shows exactly
    // what the guard will see — including a stored key that is no longer in
    // the catalogue and therefore grants nothing.
    effectivePermissions: [
      ...resolveEffectivePermissions(
        rolePermissions,
        directPermissions.map((grant) => grant.permission),
      ),
    ].sort(),
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
  };
}
