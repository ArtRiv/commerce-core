-- staff.manage: the permission that manages who works here.
-- See docs/specs/staff-management.md, invariant 9.
--
-- No table changes — this migration exists only to carry reference data into
-- databases that already exist. prisma/seed.ts remains the single source of
-- truth for the catalogue and the roles, derived from
-- src/auth/authz/permissions.ts and role-permissions.ts; it is not copied here.
-- What is copied here is the ONE fact a running database cannot learn from a
-- code change: production's `admin` role has fourteen rows in
-- role_permissions, and the fifteenth does not appear because a constant did.
--
-- Without this, the feature ships inaccessible: nobody holds staff.manage, and
-- the only route that could grant it requires staff.manage. That is the
-- definition of unreachable, and the fix would be an UPDATE in the database —
-- exactly what the spec exists to end.
--
-- Idempotent on both statements, because the deploy runs `migrate deploy` and
-- then `prisma db seed` (docker/entrypoint.sh) and the two must not fight.
-- Additive, so it is safe in either order against the deployed code: no
-- existing code path reads this key.

-- The id is generated here because `permissions.id` is a Prisma-side cuid with
-- no database default. A uuid in that column is fine — it is a TEXT primary
-- key, and nothing parses it. `description` is left NULL to match what the
-- seed writes (`create: { key }`), so a database that was migrated and one
-- that was seeded from scratch hold the same row.
INSERT INTO "permissions" ("id", "key")
VALUES (gen_random_uuid()::text, 'staff.manage')
ON CONFLICT ("key") DO NOTHING;

-- Only `admin`. `operator` is whoever runs the store, not whoever hires for
-- it — and this permission grants every other one, two steps out.
--
-- The SELECT is what keeps this honest across databases: role and permission
-- ids differ per environment, so the link is resolved by name and key rather
-- than by any id written into this file. A database with no `admin` role
-- inserts nothing and does not fail.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."name" = 'admin' AND p."key" = 'staff.manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
