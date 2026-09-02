import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

import { PERMISSIONS } from '../src/auth/authz/permissions';
import { PasswordService } from '../src/auth/password.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './support/app';
import { createUserWithRole, resetCatalogTables } from './support/catalog-db';
import { resetAuthTables } from './support/db';

const PASSWORD = 'correct horse battery staple';

const ADMIN = 'staff-admin@example.com';
const OPERATOR = 'staff-operator@example.com';
const CUSTOMER = 'staff-customer@example.com';

interface StaffGrant {
  permission: string;
  grantedAt: string;
  grantedById: string | null;
}

interface StaffAccount {
  id: string;
  email: string;
  name: string | null;
  role: string;
  rolePermissions: string[];
  directPermissions: StaffGrant[];
  effectivePermissions: string[];
  emailVerifiedAt: string | null;
  createdAt: string;
}

interface StaffPage {
  items: StaffAccount[];
  total: number;
  page: number;
  perPage: number;
}

/**
 * Covers docs/specs/staff-management.md at the HTTP level, against the real
 * database.
 *
 * The unit tests prove the refusals and what gets bound to the locking query.
 * What only a real Postgres and a real guard chain can falsify is the part
 * this feature actually promises:
 *
 *  - a permission granted through the API reaches the guard on the account's
 *    NEXT request, with the token it already held — and revoking closes the
 *    door the same way, which is the one property the store owner will lean on;
 *  - the last-administrator guard counts HOLDERS of staff.manage, so a store
 *    with no `admin` account at all still knows whether somebody can manage
 *    access;
 *  - the recorte of the listing, which no mock can prove because it is a
 *    `where` clause against rows that have to exist.
 *
 * Roles and grants are occasionally written straight to the database, and only
 * where the API deliberately cannot reach: setting up a store with zero admin
 * accounts is not an operation this API offers, and it is precisely the state
 * the guard exists for.
 */
describe('Staff management (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let resetRateLimits: () => void;

  let adminId: string;
  let operatorId: string;
  let customerId: string;

  let adminToken: string;
  let operatorToken: string;
  let customerToken: string;

  let passwordHash: string;

  beforeAll(async () => {
    ({ app, prisma, resetRateLimits } = await createTestApp());
    passwordHash = await app.get(PasswordService).hash(PASSWORD);

    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);

    adminId = (
      await createUserWithRole(prisma, {
        email: ADMIN,
        passwordHash,
        roleName: 'admin',
      })
    ).id;
    operatorId = (
      await createUserWithRole(prisma, {
        email: OPERATOR,
        passwordHash,
        roleName: 'operator',
      })
    ).id;
    customerId = (
      await createUserWithRole(prisma, {
        email: CUSTOMER,
        passwordHash,
        roleName: 'customer',
      })
    ).id;

    adminToken = await login(ADMIN);
    operatorToken = await login(OPERATOR);
    customerToken = await login(CUSTOMER);
  });

  beforeEach(async () => {
    // Grants and roles are what these tests move, so both go back to the
    // fixture state. The three fixture accounts survive on purpose: their ids
    // are inside the tokens issued once in beforeAll.
    await prisma.userPermission.deleteMany({});
    await prisma.user.deleteMany({
      where: { id: { notIn: [adminId, operatorId, customerId] } },
    });
    await setRole(adminId, 'admin');
    await setRole(operatorId, 'operator');
    await setRole(customerId, 'customer');
    await resetCatalogTables(prisma);
    resetRateLimits();
  });

  afterAll(async () => {
    await resetCatalogTables(prisma);
    await resetAuthTables(prisma);
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function login(email: string): Promise<string> {
    const response = await http()
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  }

  async function setRole(userId: string, roleName: string): Promise<void> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { name: roleName },
      select: { id: true },
    });

    await prisma.user.update({
      where: { id: userId },
      data: { roleId: role.id },
    });
  }

  /** A grant written past the API — for states the API refuses to create. */
  async function grantInDatabase(userId: string, key: string): Promise<void> {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key },
      select: { id: true },
    });

    await prisma.userPermission.create({
      data: { userId, permissionId: permission.id },
    });
  }

  /** An extra account with a role, and a token for it. */
  async function account(
    email: string,
    roleName: string,
  ): Promise<{ id: string; token: string }> {
    const { id } = await createUserWithRole(prisma, {
      email,
      passwordHash,
      roleName,
    });

    return { id, token: await login(email) };
  }

  const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` });

  describe('who may call these routes at all', () => {
    const routes: [string, () => request.Test][] = [
      ['GET /staff', () => http().get('/staff')],
      [
        'PATCH /staff/{id}/role',
        () =>
          http().patch(`/staff/${customerId}/role`).send({ role: 'operator' }),
      ],
      [
        'POST /staff/{id}/permissions',
        () =>
          http()
            .post(`/staff/${customerId}/permissions`)
            .send({ permission: PERMISSIONS.PRODUCTS_CREATE }),
      ],
      [
        'DELETE /staff/{id}/permissions/{permission}',
        () =>
          http().delete(
            `/staff/${customerId}/permissions/${PERMISSIONS.PRODUCTS_CREATE}`,
          ),
      ],
    ];

    it.each(routes)('401s %s without a token', async (_label, call) => {
      await call().expect(401);
    });

    it.each(routes)('403s %s for a customer', async (_label, call) => {
      await call().set('Authorization', `Bearer ${customerToken}`).expect(403);
    });

    // The role that runs the store, and holds six permissions — none of them
    // this one. Operators operate; they do not hire.
    it.each(routes)('403s %s for an operator', async (_label, call) => {
      await call().set('Authorization', `Bearer ${operatorToken}`).expect(403);
    });

    it('lets an operator carrying the grant through — the delegation is delegable', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.STAFF_MANAGE })
        .expect(200);

      await http()
        .get('/staff')
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
    });
  });

  describe('listing the team', () => {
    it('lists the non-default roles and leaves plain shoppers out', async () => {
      const response = await http().get('/staff').set(asAdmin()).expect(200);
      const page = response.body as StaffPage;
      const emails = page.items.map((item) => item.email);

      expect(emails).toContain(ADMIN);
      expect(emails).toContain(OPERATOR);
      expect(emails).not.toContain(CUSTOMER);
      expect(page.total).toBe(2);
    });

    it('lists a customer who holds a grant — staff by capability', async () => {
      await http()
        .post(`/staff/${customerId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.REPORTS_READ })
        .expect(200);

      const response = await http().get('/staff').set(asAdmin()).expect(200);

      expect((response.body as StaffPage).items.map((i) => i.email)).toContain(
        CUSTOMER,
      );
    });

    it('finds a plain customer by exact address, which is the only way in', async () => {
      const response = await http()
        .get('/staff')
        .query({ email: CUSTOMER })
        .set(asAdmin())
        .expect(200);
      const page = response.body as StaffPage;

      expect(page.total).toBe(1);
      expect(page.items[0].id).toBe(customerId);
      expect(page.items[0].role).toBe('customer');
    });

    it('matches the address the way registration stored it', async () => {
      const response = await http()
        .get('/staff')
        .query({ email: 'Staff-Customer@Example.com' })
        .set(asAdmin())
        .expect(200);

      expect((response.body as StaffPage).total).toBe(1);
    });

    it('answers an unknown address with an empty page, not a 404', async () => {
      const response = await http()
        .get('/staff')
        .query({ email: 'ninguem@example.com' })
        .set(asAdmin())
        .expect(200);

      expect(response.body).toMatchObject({ items: [], total: 0 });
    });

    it('separates the role from the grant, and reports the union', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(200);

      const response = await http()
        .get('/staff')
        .query({ email: OPERATOR })
        .set(asAdmin())
        .expect(200);
      const [operator] = (response.body as StaffPage).items;

      expect(operator.rolePermissions).toContain(PERMISSIONS.PRODUCTS_READ);
      expect(operator.rolePermissions).not.toContain(
        PERMISSIONS.PRODUCTS_CREATE,
      );
      expect(operator.directPermissions).toHaveLength(1);
      expect(operator.directPermissions[0].permission).toBe(
        PERMISSIONS.PRODUCTS_CREATE,
      );
      // The provenance the schema has always stored and never showed.
      expect(operator.directPermissions[0].grantedById).toBe(adminId);
      expect(
        Number.isNaN(Date.parse(operator.directPermissions[0].grantedAt)),
      ).toBe(false);
      expect(operator.effectivePermissions).toEqual(
        expect.arrayContaining([
          PERMISSIONS.PRODUCTS_READ,
          PERMISSIONS.PRODUCTS_CREATE,
        ]),
      );
    });

    it('never puts a credential column on the wire', async () => {
      const response = await http().get('/staff').set(asAdmin()).expect(200);

      // The hazard docs/admin-api.md names outright: one `include: { user }`
      // and a back-office listing hands out every password hash it has.
      expect(response.text).not.toContain('passwordHash');
      expect(response.text).not.toContain('googleId');
    });
  });

  describe('changing a role', () => {
    it('promotes a shopper, and the next request with the same token can see it', async () => {
      await http()
        .get('/products')
        .query({ status: 'all' })
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);

      const response = await http()
        .patch(`/staff/${customerId}/role`)
        .set(asAdmin())
        .send({ role: 'operator' })
        .expect(200);

      expect((response.body as StaffAccount).role).toBe('operator');

      await http()
        .get('/products')
        .query({ status: 'all' })
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
    });

    it('400s an unknown role and names the ones that exist', async () => {
      const response = await http()
        .patch(`/staff/${customerId}/role`)
        .set(asAdmin())
        .send({ role: 'gerente' })
        .expect(400);

      expect((response.body as { message: string }).message).toContain(
        'operator',
      );
    });

    it('404s an account that does not exist', async () => {
      await http()
        .patch('/staff/2f1c9d7e-0000-4000-8000-000000000000/role')
        .set(asAdmin())
        .send({ role: 'operator' })
        .expect(404);
    });

    it('409s the caller changing their own role', async () => {
      await http()
        .patch(`/staff/${adminId}/role`)
        .set(asAdmin())
        .send({ role: 'customer' })
        .expect(409);
    });

    it('leaves a grant standing across a demotion', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(200);

      const response = await http()
        .patch(`/staff/${operatorId}/role`)
        .set(asAdmin())
        .send({ role: 'customer' })
        .expect(200);
      const account = response.body as StaffAccount;

      expect(account.rolePermissions).toEqual([]);
      expect(account.effectivePermissions).toEqual([
        PERMISSIONS.PRODUCTS_CREATE,
      ]);
    });
  });

  describe('granting and revoking', () => {
    /** The whole point of the feature, start to finish. */
    it('hires a cataloguer: promote, grant, and the account can create a piece', async () => {
      await http()
        .patch(`/staff/${customerId}/role`)
        .set(asAdmin())
        .send({ role: 'operator' })
        .expect(200);

      for (const permission of [
        PERMISSIONS.PRODUCTS_CREATE,
        PERMISSIONS.PRODUCTS_UPDATE,
        PERMISSIONS.PRODUCTS_DELETE,
      ]) {
        await http()
          .post(`/staff/${customerId}/permissions`)
          .set(asAdmin())
          .send({ permission })
          .expect(200);
      }

      // Same token the account already held before any of this.
      const created = await http()
        .post('/products')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ name: 'Camiseta Nova', priceCents: 9990 })
        .expect(201);

      expect((created.body as { name: string }).name).toBe('Camiseta Nova');

      // And nothing beyond what was handed over: refund moves real money and
      // was never granted.
      await http()
        .post('/orders/2f1c9d7e-0000-4000-8000-000000000000/refund')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(403);
    });

    it('closes the door on the very next request when revoked', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(200);

      await http()
        .post('/products')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ name: 'Peça Um', priceCents: 4990 })
        .expect(201);

      await http()
        .delete(
          `/staff/${operatorId}/permissions/${PERMISSIONS.PRODUCTS_CREATE}`,
        )
        .set(asAdmin())
        .expect(200);

      // No new token, no waiting for the old one to expire: permissions are
      // resolved from the database on every request.
      await http()
        .post('/products')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ name: 'Peça Dois', priceCents: 4990 })
        .expect(403);
    });

    it('is idempotent, and keeps the first grant’s provenance', async () => {
      const first = await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(200);

      const second = await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(200);

      const grantOf = (body: unknown) =>
        (body as StaffAccount).directPermissions[0];

      expect(grantOf(second.body).grantedAt).toBe(
        grantOf(first.body).grantedAt,
      );
      expect((second.body as StaffAccount).directPermissions).toHaveLength(1);
    });

    it('400s a key that is not in the catalogue', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: 'products.teleport' })
        .expect(400);

      await http()
        .delete(`/staff/${operatorId}/permissions/products.teleport`)
        .set(asAdmin())
        .expect(400);
    });

    it('409s the caller granting to themselves', async () => {
      await http()
        .post(`/staff/${adminId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(409);
    });

    it('404s revoking a permission that comes from the role, and says so', async () => {
      const response = await http()
        .delete(`/staff/${operatorId}/permissions/${PERMISSIONS.PRODUCTS_READ}`)
        .set(asAdmin())
        .expect(404);

      expect((response.body as { message: string }).message).toMatch(/role/i);
    });

    it('404s an account that does not exist', async () => {
      await http()
        .post('/staff/2f1c9d7e-0000-4000-8000-000000000000/permissions')
        .set(asAdmin())
        .send({ permission: PERMISSIONS.PRODUCTS_CREATE })
        .expect(404);
    });
  });

  describe('the store never runs out of administrators', () => {
    /**
     * Both of these run with NO account holding the `admin` role, which is the
     * point: a guard that counted admins would answer wrongly in both. The
     * state is built in the database because the API has no route that removes
     * the last admin — which is exactly what it is being tested for.
     */
    it('refuses the sole holder renouncing, and says why', async () => {
      await setRole(adminId, 'customer');
      const chief = await account('staff-chief@example.com', 'operator');
      await grantInDatabase(chief.id, PERMISSIONS.STAFF_MANAGE);

      const response = await http()
        .delete(`/staff/${chief.id}/permissions/${PERMISSIONS.STAFF_MANAGE}`)
        .set('Authorization', `Bearer ${chief.token}`)
        .expect(409);

      expect((response.body as { message: string }).message).toContain(
        'staff.manage',
      );

      // And nothing was taken: they are still the administrator.
      await http()
        .get('/staff')
        .set('Authorization', `Bearer ${chief.token}`)
        .expect(200);
    });

    it('lets a holder renounce while a second one remains — holders, not roles', async () => {
      await setRole(adminId, 'customer');
      const first = await account('staff-chief-one@example.com', 'operator');
      const second = await account('staff-chief-two@example.com', 'operator');
      await grantInDatabase(first.id, PERMISSIONS.STAFF_MANAGE);
      await grantInDatabase(second.id, PERMISSIONS.STAFF_MANAGE);

      const response = await http()
        .delete(`/staff/${first.id}/permissions/${PERMISSIONS.STAFF_MANAGE}`)
        .set('Authorization', `Bearer ${first.token}`)
        .expect(200);

      expect(
        (response.body as StaffAccount).effectivePermissions,
      ).not.toContain(PERMISSIONS.STAFF_MANAGE);

      // Renounced means renounced, on the next request and with the same token.
      await http()
        .get('/staff')
        .set('Authorization', `Bearer ${first.token}`)
        .expect(403);

      await http()
        .get('/staff')
        .set('Authorization', `Bearer ${second.token}`)
        .expect(200);
    });

    it('lets an admin take the grant back from a delegate', async () => {
      await http()
        .post(`/staff/${operatorId}/permissions`)
        .set(asAdmin())
        .send({ permission: PERMISSIONS.STAFF_MANAGE })
        .expect(200);

      await http()
        .delete(`/staff/${operatorId}/permissions/${PERMISSIONS.STAFF_MANAGE}`)
        .set(asAdmin())
        .expect(200);

      await http()
        .get('/staff')
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(403);
    });

    it('does not refuse a revoke the role makes harmless', async () => {
      // The admin's own role carries staff.manage, so removing a redundant
      // grant changes nothing effective and must not trip the guard.
      await grantInDatabase(adminId, PERMISSIONS.STAFF_MANAGE);

      const response = await http()
        .delete(`/staff/${adminId}/permissions/${PERMISSIONS.STAFF_MANAGE}`)
        .set(asAdmin())
        .expect(200);
      const account = response.body as StaffAccount;

      expect(account.directPermissions).toEqual([]);
      expect(account.effectivePermissions).toContain(PERMISSIONS.STAFF_MANAGE);
    });
  });
});
