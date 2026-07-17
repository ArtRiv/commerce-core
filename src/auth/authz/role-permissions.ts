import { type Permission, PERMISSIONS } from './permissions';

const CATALOG = new Set<string>(Object.values(PERMISSIONS));

interface DefaultRole {
  name: string;
  description: string;
  isDefault: boolean;
  permissions: readonly Permission[];
}

export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    name: 'customer',
    description: 'Default role for shoppers. No back-office access.',
    isDefault: true,
    permissions: [],
  },
  {
    name: 'operator',
    description: 'Back-office staff: manage orders, read catalog and reports.',
    isDefault: false,
    permissions: [
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_UPDATE_STATUS,
      PERMISSIONS.CUSTOMERS_READ,
      PERMISSIONS.COUPONS_READ,
      PERMISSIONS.REPORTS_READ,
    ],
  },
  {
    name: 'admin',
    description: 'Full access to every permission in the catalog.',
    isDefault: false,
    permissions: Object.values(PERMISSIONS),
  },
];

export function resolveEffectivePermissions(
  rolePermissionKeys: readonly string[],
  userGrantKeys: readonly string[] = [],
): Set<Permission> {
  const effective = new Set<Permission>();

  for (const key of [...rolePermissionKeys, ...userGrantKeys]) {
    if (CATALOG.has(key)) {
      effective.add(key as Permission);
    }
  }

  return effective;
}
