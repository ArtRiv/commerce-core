export const PERMISSIONS = {
  PRODUCTS_READ: 'products.read',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_UPDATE: 'products.update',
  PRODUCTS_DELETE: 'products.delete',

  ORDERS_READ: 'orders.read',
  ORDERS_UPDATE_STATUS: 'orders.update_status',
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_REFUND: 'orders.refund',

  CUSTOMERS_READ: 'customers.read',

  COUPONS_READ: 'coupons.read',
  COUPONS_CREATE: 'coupons.create',
  COUPONS_UPDATE: 'coupons.update',
  COUPONS_DELETE: 'coupons.delete',

  REPORTS_READ: 'reports.read',

  /**
   * Manage who works here: list staff, change a role, grant and revoke a
   * per-user permission (docs/specs/staff-management.md).
   *
   * It belongs to `admin` alone, and it is deliberately grantable rather than
   * derived from being admin — the store owner wants a second person doing
   * this work, which means the delegation has to be delegable.
   *
   * Read that as: **granting this is granting everything.** Not in one step,
   * but in two nobody can prevent, because whoever manages access can move an
   * account to `admin`, and `admin` is this whole catalogue. Invariant 2 of
   * the spec says so in more words; the short version belongs here, where
   * somebody choosing a permission to hand out will actually read it.
   */
  STAFF_MANAGE: 'staff.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
