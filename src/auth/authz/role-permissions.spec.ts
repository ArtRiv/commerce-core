import { type Permission, PERMISSIONS } from './permissions';
import { DEFAULT_ROLES, resolveEffectivePermissions } from './role-permissions';

function role(name: string): { permissions: readonly Permission[] } {
  const found = DEFAULT_ROLES.find((candidate) => candidate.name === name);

  if (!found) {
    throw new Error(`No default role named ${name}`);
  }

  return found;
}

/**
 * The seeded reference data, asserted from the code it is derived from.
 *
 * Small, and load-bearing for exactly one reason: `staff.manage` is the
 * permission that grants every other permission, so where it lives is not a
 * detail of the catalogue. Dropped from `admin`, the store has nobody who can
 * hand out access and no route through which to fix that — the failure mode
 * is a database UPDATE, which is what docs/specs/staff-management.md exists to
 * end. Added to `operator`, every back-office employee can promote themselves.
 */
describe('default roles', () => {
  it('gives admin every permission in the catalogue', () => {
    const admin = new Set<string>(role('admin').permissions);

    for (const key of Object.values(PERMISSIONS)) {
      expect(admin.has(key)).toBe(true);
    }
  });

  it('puts staff.manage in admin and nowhere else', () => {
    for (const { name, permissions } of DEFAULT_ROLES) {
      expect([name, permissions.includes(PERMISSIONS.STAFF_MANAGE)]).toEqual([
        name,
        name === 'admin',
      ]);
    }
  });

  it('leaves the default role with no permission at all', () => {
    const customer = DEFAULT_ROLES.find((candidate) => candidate.isDefault);

    expect(customer?.name).toBe('customer');
    expect(customer?.permissions).toEqual([]);
  });
});

describe('resolveEffectivePermissions', () => {
  it('unions the role with the per-user grants', () => {
    const effective = resolveEffectivePermissions(
      [PERMISSIONS.PRODUCTS_READ],
      [PERMISSIONS.PRODUCTS_CREATE],
    );

    expect([...effective].sort()).toEqual(
      [PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_READ].sort(),
    );
  });

  it('counts a permission held twice once', () => {
    const effective = resolveEffectivePermissions(
      [PERMISSIONS.PRODUCTS_READ],
      [PERMISSIONS.PRODUCTS_READ],
    );

    expect([...effective]).toEqual([PERMISSIONS.PRODUCTS_READ]);
  });

  // A key that left the catalogue but not the database — the row survives a
  // deploy that removed the constant, and must not grant anything.
  it('discards a key that is not in the catalogue', () => {
    const effective = resolveEffectivePermissions([], ['products.teleport']);

    expect([...effective]).toEqual([]);
  });
});
