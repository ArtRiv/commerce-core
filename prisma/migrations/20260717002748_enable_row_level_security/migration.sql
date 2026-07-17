-- Enable Row Level Security on every application table.
--
-- Supabase serves this database over PostgREST to the `anon` and
-- `authenticated` roles, and the anon key is public by design. Without RLS
-- those roles can read and write every row directly over HTTP, bypassing the
-- API's guards entirely — anyone holding the anon key could read `users` or
-- grant themselves an admin role. Prisma is not the only door into this DB.
--
-- No policies are created, on purpose. A table with RLS enabled and zero
-- policies denies everything to non-owner roles, which is exactly right here:
-- this is a headless backend that never talks to the DB through supabase-js.
-- All legitimate access arrives via Prisma, which connects as the table owner,
-- and owners bypass RLS unless FORCE ROW LEVEL SECURITY is set — so the API
-- keeps working untouched while PostgREST is shut out.
--
-- If some future feature does need direct client access, it adds the narrow
-- policy it needs. The default stays deny.

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;

-- Prisma's own bookkeeping table, not part of the schema, but exposed over the
-- same public API — and writable by anon, which would let an attacker corrupt
-- migration state. Prisma still owns it and so is unaffected.
--
-- IF EXISTS because this table is absent from the shadow database Prisma builds
-- to validate migrations; without it, `migrate dev` fails on 42P01 there.
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
