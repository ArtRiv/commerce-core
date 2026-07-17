import type { Permission } from './authz/permissions';

/**
 * The authenticated principal attached to `request.user`.
 *
 * Produced by `JwtStrategy.validate()` and consumed by `PermissionsGuard` and
 * the `@CurrentUser()` decorator. `permissions` is already resolved (role
 * permissions ∪ per-user grants) — nothing downstream should need to hit the
 * DB again to answer "can this request do X?".
 */
export interface AuthenticatedUser {
  id: string;
  /** Role *name* (e.g. 'admin'). Roles are DB rows, so this is not an enum. */
  role: string;
  permissions: ReadonlySet<Permission>;
}
