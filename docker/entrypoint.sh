#!/bin/sh
#
# Release phase, then the app.
#
# Render's pre-deploy command — the hook this belongs in — requires a paid
# instance type, and a free service has no shell to run it by hand from. So
# container start is the only hook that exists, and this is what goes in it
# (docs/specs/deploy.md).
#
# Both steps are idempotent by design: `migrate deploy` applies only what the
# _prisma_migrations table says is missing, and prisma/seed.ts upserts roles and
# permissions so that src/auth/authz/role-permissions.ts stays the source of
# truth on every boot. Re-running them on a wake-from-idle costs a second or
# two against a cold start that already costs about sixty.
#
# `set -e` is the point of the whole file: if the database is unreachable or a
# migration fails, the container dies and Render marks the deploy failed. The
# alternative — starting anyway — is a service whose health check passes while
# every real route 500s, which on a plan with no shell is the worst place to
# find out that DATABASE_URL had a typo.
set -e

echo "==> prisma migrate deploy"
node node_modules/prisma/build/index.js migrate deploy

echo "==> seeding roles and permissions"
node dist/prisma/seed.js

echo "==> starting commerce-core"
exec "$@"
