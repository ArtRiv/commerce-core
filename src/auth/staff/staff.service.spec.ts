import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../authenticated-user';
import { PERMISSIONS } from '../authz/permissions';
import { resolveEffectivePermissions } from '../authz/role-permissions';
import { StaffService } from './staff.service';

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

const NOW = new Date('2026-09-02T12:00:00.000Z');

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'user-1',
    email: 'staff@example.com',
    name: 'Staff',
    emailVerifiedAt: NOW,
    createdAt: NOW,
    role: { name: 'operator', permissions: [] },
    permissionsGrantedToUser: [],
    ...overrides,
  };
}

function roleRow(name: string, keys: string[]) {
  return {
    id: `role-${name}`,
    name,
    permissions: keys.map((key) => ({ permission: { key } })),
  };
}

function caller(id = 'caller-1'): AuthenticatedUser {
  return {
    id,
    role: 'admin',
    permissions: resolveEffectivePermissions([PERMISSIONS.STAFF_MANAGE]),
  };
}

function createPrismaMock() {
  const client = {
    user: {
      findUnique: jest
        .fn<Promise<AccountRow | null>, [unknown]>()
        .mockResolvedValue(accountRow()),
      findMany: jest
        .fn<Promise<AccountRow[]>, [unknown]>()
        .mockResolvedValue([]),
      count: jest.fn<Promise<number>, [unknown]>().mockResolvedValue(0),
      update: jest
        .fn<Promise<unknown>, [unknown]>()
        .mockResolvedValue(accountRow()),
    },
    role: {
      findUnique: jest
        .fn<Promise<ReturnType<typeof roleRow> | null>, [unknown]>()
        .mockResolvedValue(roleRow('operator', [PERMISSIONS.PRODUCTS_READ])),
      findMany: jest
        .fn<Promise<{ name: string }[]>, [unknown]>()
        .mockResolvedValue([
          { name: 'admin' },
          { name: 'customer' },
          { name: 'operator' },
        ]),
    },
    permission: {
      findUnique: jest
        .fn<Promise<{ id: string } | null>, [unknown]>()
        .mockResolvedValue({ id: 'permission-1' }),
    },
    userPermission: {
      upsert: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
      delete: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
    },
    /** The locking SELECT: returns the ids of everyone holding staff.manage. */
    $queryRaw: jest
      .fn<Promise<{ id: string }[]>, unknown[]>()
      .mockResolvedValue([{ id: 'caller-1' }, { id: 'user-1' }]),
    $transaction: jest.fn(
      (
        arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
      ): Promise<unknown> =>
        typeof arg === 'function' ? arg(client) : Promise.all(arg),
    ),
  };

  return client;
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

function serviceWith(prisma: PrismaMock): StaffService {
  return new StaffService(prisma as unknown as PrismaService);
}

/** The `where` a Prisma call was made with, without an `any` in sight. */
function whereOf(call: unknown): Record<string, unknown> {
  return (call as { where: Record<string, unknown> }).where;
}

describe('StaffService', () => {
  describe('list', () => {
    it('restricts the listing to a non-default role or a direct grant', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).list({});

      const [args] = prisma.user.findMany.mock.calls[0];
      // The two halves of invariant 4: promoted accounts, plus the customer
      // who is staff by capability. Plain shoppers are neither, and listing
      // them is customers.read's job, not this route's.
      expect(whereOf(args)).toEqual({
        OR: [
          { role: { isDefault: false } },
          { permissionsGrantedToUser: { some: {} } },
        ],
      });
    });

    it('reaches past that recorte for an exact email', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).list({ email: 'novo@example.com' });

      const [args] = prisma.user.findMany.mock.calls[0];
      // Exactly the point: whoever is about to be promoted is not staff yet,
      // so without this the only way to their id is the database.
      expect(whereOf(args)).toEqual({ email: 'novo@example.com' });
    });

    it('normalizes the searched address, as registration does', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).list({ email: '  Novo@Example.COM ' });

      const [args] = prisma.user.findMany.mock.calls[0];
      expect(whereOf(args)).toEqual({ email: 'novo@example.com' });
    });

    it('clamps perPage at 100 rather than rejecting it', async () => {
      const prisma = createPrismaMock();

      const page = await serviceWith(prisma).list({ perPage: 5000 });

      const [args] = prisma.user.findMany.mock.calls[0] as [{ take: number }];
      expect(args.take).toBe(100);
      expect(page.perPage).toBe(100);
    });

    it('reports what the guard will see: the role united with the grants', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockResolvedValue([
        accountRow({
          role: {
            name: 'operator',
            permissions: [{ permission: { key: PERMISSIONS.PRODUCTS_READ } }],
          },
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: 'caller-1',
              permission: { key: PERMISSIONS.PRODUCTS_CREATE },
            },
          ],
        }),
      ]);
      prisma.user.count.mockResolvedValue(1);

      const page = await serviceWith(prisma).list({});

      expect(page.items[0].rolePermissions).toEqual([
        PERMISSIONS.PRODUCTS_READ,
      ]);
      expect(page.items[0].directPermissions).toEqual([
        {
          permission: PERMISSIONS.PRODUCTS_CREATE,
          grantedAt: NOW,
          grantedById: 'caller-1',
        },
      ]);
      expect(page.items[0].effectivePermissions).toEqual([
        PERMISSIONS.PRODUCTS_CREATE,
        PERMISSIONS.PRODUCTS_READ,
      ]);
      expect(page.total).toBe(1);
    });

    it('drops a stored key that is no longer in the catalogue', async () => {
      const prisma = createPrismaMock();
      prisma.user.findMany.mockResolvedValue([
        accountRow({
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: null,
              permission: { key: 'products.teleport' },
            },
          ],
        }),
      ]);

      const page = await serviceWith(prisma).list({});

      // It is still a row, and it still grants nothing — same reading the
      // jwt.strategy gives it, because it is the same function.
      expect(page.items[0].directPermissions[0].permission).toBe(
        'products.teleport',
      );
      expect(page.items[0].effectivePermissions).toEqual([]);
    });
  });

  describe('changeRole', () => {
    it('refuses to change the caller’s own role', async () => {
      const prisma = createPrismaMock();

      await expect(
        serviceWith(prisma).changeRole(caller(), 'caller-1', 'admin'),
      ).rejects.toThrow(ConflictException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('400s an unknown role, naming the ones that exist', async () => {
      const prisma = createPrismaMock();
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).changeRole(caller(), 'user-1', 'manager'),
      ).rejects.toThrow(/admin, customer, operator/);
      await expect(
        serviceWith(prisma).changeRole(caller(), 'user-1', 'manager'),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s an account that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).changeRole(caller(), 'ghost', 'operator'),
      ).rejects.toThrow(NotFoundException);
    });

    it('writes the new role', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).changeRole(caller(), 'user-1', 'operator');

      const [args] = prisma.user.update.mock.calls[0] as [
        { where: { id: string }; data: { roleId: string } },
      ];
      expect(args).toMatchObject({
        where: { id: 'user-1' },
        data: { roleId: 'role-operator' },
      });
    });

    /**
     * Unreachable over HTTP today — the caller holds staff.manage and cannot
     * be the target, so a second holder always exists. Tested anyway, because
     * the guard is written over the count rather than over that argument
     * (docs/specs/staff-management.md, invariant 1).
     */
    it('refuses a demotion that would strip the last holder', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          role: {
            name: 'admin',
            permissions: [{ permission: { key: PERMISSIONS.STAFF_MANAGE } }],
          },
        }),
      );

      await expect(
        serviceWith(prisma).changeRole(caller(), 'user-1', 'operator'),
      ).rejects.toThrow(ConflictException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('allows the demotion while another holder remains', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([
        { id: 'caller-1' },
        { id: 'user-1' },
      ]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          role: {
            name: 'admin',
            permissions: [{ permission: { key: PERMISSIONS.STAFF_MANAGE } }],
          },
        }),
      );

      await serviceWith(prisma).changeRole(caller(), 'user-1', 'operator');

      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('does not strip anyone whose direct grant survives the demotion', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          role: {
            name: 'admin',
            permissions: [{ permission: { key: PERMISSIONS.STAFF_MANAGE } }],
          },
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: null,
              permission: { key: PERMISSIONS.STAFF_MANAGE },
            },
          ],
        }),
      );

      // The only holder, demoted to a role without the permission — and still
      // a holder afterwards, because the grant is his own. No refusal.
      await serviceWith(prisma).changeRole(caller(), 'user-1', 'operator');

      expect(prisma.user.update).toHaveBeenCalled();
    });
  });

  describe('grant', () => {
    it('refuses to grant the caller anything', async () => {
      const prisma = createPrismaMock();

      await expect(
        serviceWith(prisma).grant(
          caller(),
          'caller-1',
          PERMISSIONS.ORDERS_REFUND,
        ),
      ).rejects.toThrow(ConflictException);

      expect(prisma.userPermission.upsert).not.toHaveBeenCalled();
    });

    it('404s an account that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).grant(
          caller(),
          'ghost',
          PERMISSIONS.PRODUCTS_CREATE,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('records who granted it, and keeps the first grant on a repeat', async () => {
      const prisma = createPrismaMock();

      await serviceWith(prisma).grant(
        caller(),
        'user-1',
        PERMISSIONS.PRODUCTS_CREATE,
      );

      const [args] = prisma.userPermission.upsert.mock.calls[0] as [
        {
          where: unknown;
          create: { userId: string; grantedById: string };
          update: Record<string, never>;
        },
      ];
      expect(args.create).toEqual({
        userId: 'user-1',
        permissionId: 'permission-1',
        grantedById: 'caller-1',
      });
      // Empty on purpose: granting twice must not rewrite the provenance of
      // the first grant, which is the only audit trail this feature has.
      expect(args.update).toEqual({});
    });

    it('fails loudly when the catalogue row is missing from the database', async () => {
      const prisma = createPrismaMock();
      prisma.permission.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).grant(
          caller(),
          'user-1',
          PERMISSIONS.PRODUCTS_CREATE,
        ),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('revoke', () => {
    const withGrant = (key: string, role = 'operator') =>
      accountRow({
        role: { name: role, permissions: [] },
        permissionsGrantedToUser: [
          {
            grantedAt: NOW,
            grantedById: 'caller-1',
            permission: { key },
          },
        ],
      });

    it('locks the holders of staff.manage before it writes anything', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(
        withGrant(PERMISSIONS.PRODUCTS_CREATE),
      );

      await serviceWith(prisma).revoke(
        caller(),
        'user-1',
        PERMISSIONS.PRODUCTS_CREATE,
      );

      const [fragments, bound] = prisma.$queryRaw.mock.calls[0] as [
        string[],
        string,
      ];
      const sql = fragments.join('?');

      // The claim of invariant 1, asserted where a mock cannot hide it: the
      // count is over role permissions AND per-user grants, it is the same
      // key the guard checks, and the rows are locked in a fixed order.
      expect(bound).toBe(PERMISSIONS.STAFF_MANAGE);
      expect(sql).toContain('"role_permissions"');
      expect(sql).toContain('"user_permissions"');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('ORDER BY');
    });

    it('lets a holder renounce while another holder remains', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([
        { id: 'caller-1' },
        { id: 'other-1' },
      ]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          id: 'caller-1',
          role: { name: 'operator', permissions: [] },
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: 'other-1',
              permission: { key: PERMISSIONS.STAFF_MANAGE },
            },
          ],
        }),
      );

      // Renouncing is the one thing a caller may do to themselves: the set
      // only shrinks, and handing the keys back is a legitimate act.
      await serviceWith(prisma).revoke(
        caller(),
        'caller-1',
        PERMISSIONS.STAFF_MANAGE,
      );

      expect(prisma.userPermission.delete).toHaveBeenCalled();
    });

    it('refuses the last holder renouncing, and says why', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([{ id: 'caller-1' }]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          id: 'caller-1',
          role: { name: 'operator', permissions: [] },
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: null,
              permission: { key: PERMISSIONS.STAFF_MANAGE },
            },
          ],
        }),
      );

      await expect(
        serviceWith(prisma).revoke(
          caller(),
          'caller-1',
          PERMISSIONS.STAFF_MANAGE,
        ),
      ).rejects.toThrow(ConflictException);
      await expect(
        serviceWith(prisma).revoke(
          caller(),
          'caller-1',
          PERMISSIONS.STAFF_MANAGE,
        ),
      ).rejects.toThrow(/staff\.manage/);

      expect(prisma.userPermission.delete).not.toHaveBeenCalled();
    });

    it('does not refuse when the role keeps the permission anyway', async () => {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValue([{ id: 'user-1' }]);
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          role: {
            name: 'admin',
            permissions: [{ permission: { key: PERMISSIONS.STAFF_MANAGE } }],
          },
          permissionsGrantedToUser: [
            {
              grantedAt: NOW,
              grantedById: null,
              permission: { key: PERMISSIONS.STAFF_MANAGE },
            },
          ],
        }),
      );

      // The grant goes, the role still carries it, nothing effective changes.
      await serviceWith(prisma).revoke(
        caller(),
        'user-1',
        PERMISSIONS.STAFF_MANAGE,
      );

      expect(prisma.userPermission.delete).toHaveBeenCalled();
    });

    it('404s a permission the account only holds through its role', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(
        accountRow({
          role: {
            name: 'operator',
            permissions: [{ permission: { key: PERMISSIONS.PRODUCTS_READ } }],
          },
        }),
      );

      await expect(
        serviceWith(prisma).revoke(
          caller(),
          'user-1',
          PERMISSIONS.PRODUCTS_READ,
        ),
      ).rejects.toThrow(NotFoundException);
      // The message has to point somewhere, or the operator clicks again.
      await expect(
        serviceWith(prisma).revoke(
          caller(),
          'user-1',
          PERMISSIONS.PRODUCTS_READ,
        ),
      ).rejects.toThrow(/role/i);
    });

    it('404s an account that does not exist', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        serviceWith(prisma).revoke(
          caller(),
          'ghost',
          PERMISSIONS.PRODUCTS_CREATE,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('deletes exactly the one grant', async () => {
      const prisma = createPrismaMock();
      prisma.user.findUnique.mockResolvedValue(
        withGrant(PERMISSIONS.PRODUCTS_CREATE),
      );

      await serviceWith(prisma).revoke(
        caller(),
        'user-1',
        PERMISSIONS.PRODUCTS_CREATE,
      );

      const [args] = prisma.userPermission.delete.mock.calls[0];
      expect(whereOf(args)).toEqual({
        userId_permissionId: {
          userId: 'user-1',
          permissionId: 'permission-1',
        },
      });
    });
  });
});
