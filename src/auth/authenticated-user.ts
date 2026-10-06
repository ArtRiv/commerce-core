import type { Permission } from './authz/permissions';

/**
 * The authenticated principal attached to `request.user`.
 *
 * Produced by `JwtStrategy.validate()` and consumed by `PermissionsGuard` and
 * the `@CurrentUser()` decorator. `permissions` is already resolved (role
 * permissions ∪ per-user grants) — nothing downstream should need to hit the
 * DB again to answer "can this request do X?".
 *
 * `email` and `name` are included so order-level operations (e.g. creating a
 * PIX customer at Asaas) can forward buyer identity without an extra DB round-trip.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  /** Null on accounts created through Google that never set a display name. */
  name: string | null;
  /** Role *name* (e.g. 'admin'). Roles are DB rows, so this is not an enum. */
  role: string;
  permissions: ReadonlySet<Permission>;
}
