# The production image.
#
# Docker rather than Render's native Node runtime, for one reason that matters
# on the free plan: there is no shell access there, so a build that goes wrong
# is debugged by pushing commits and reading logs. Pinning Node and pnpm to the
# exact versions in .nvmrc and package.json#packageManager — instead of hoping
# the platform's corepack resolves them — makes the image something that can be
# built and booted on a laptop before it is ever pushed (docs/specs/deploy.md).

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22.18.0-bookworm-slim AS build

WORKDIR /app

# Without this corepack asks "do you want to download pnpm?" on first use, and
# a build has no one to answer it — the prompt is not skipped in a
# non-interactive shell, it fails the build.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# corepack ships with Node and reads packageManager out of package.json, so the
# pnpm version here is the one the lockfile was written by. Copying only the
# manifests first keeps the install layer cached across source-only changes.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# src/generated is gitignored, so the client has to be generated here. It reads
# the schema and never the database, so no DATABASE_URL is involved.
RUN pnpm exec prisma generate && pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22.18.0-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# node_modules arrives whole, dev dependencies included, and that is deliberate
# rather than sloppy. The entrypoint runs `prisma migrate deploy` (the `prisma`
# CLI is a dev dependency) and dist/prisma/seed.js opens with
# `require('dotenv/config')` (likewise). Pruning would save perhaps 150 MB and
# buy a class of failure — "works locally, missing module in production" — that
# can only be discovered on a platform with no shell to look with.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The Prisma CLI needs both: the migrations to apply, and prisma.config.ts,
# which is where the datasource URL comes from (the schema's datasource block
# deliberately declares no `url`).
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY package.json ./

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Drop root. The image writes nothing outside /tmp, so the unprivileged `node`
# user that the base image already ships is enough.
USER node

# Documentation only — Render injects PORT and main.ts reads it.
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
