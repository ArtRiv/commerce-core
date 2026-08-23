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

# openssl HERE as well as in the runtime stage, and that symmetry is the whole
# point: Prisma picks its engine build from the libssl it detects. With openssl
# missing here and present there, `prisma generate` resolves one target at build
# time and the CLI asks for a different one at run time — then tries to download
# it into node_modules, which the unprivileged user cannot write to. Same
# packages in both stages, same engine, nothing to fetch later.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

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

# Prisma's schema engine — the Rust binary behind `migrate deploy` — probes for
# libssl and, on a -slim image, finds nothing to probe. It then warns twice per
# deploy that it is "defaulting to openssl-1.1.x" and "may not work as
# expected". It happens to work anyway, which is the problem: a warning that
# always appears and never means anything is a warning nobody reads, and the
# day it does matter it will scroll past with the rest. ~5 MB to make the
# deploy log say only what is true.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# node_modules arrives whole, dev dependencies included, and that is deliberate
# rather than sloppy. The entrypoint runs `prisma migrate deploy` (the `prisma`
# CLI is a dev dependency) and dist/prisma/seed.js opens with
# `require('dotenv/config')` (likewise). Pruning would save perhaps 150 MB and
# buy a class of failure — "works locally, missing module in production" — that
# can only be discovered on a platform with no shell to look with.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The Prisma CLI needs both: the migrations to apply, and prisma.config.ts,
# which is where the datasource URL comes from (the schema's datasource block
# deliberately declares no `url`).
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY package.json ./

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Drop root, running as the unprivileged `node` user the base image ships.
#
# This used to be justified with "the image writes nothing outside /tmp", which
# was wrong and cost a broken deploy: the Prisma CLI writes into
# node_modules/@prisma/engines when the engine it wants is not already there.
# The --chown above is what makes that possible rather than a crash loop, and
# installing openssl in BOTH stages is what makes it unnecessary in the first
# place. Keep both — the chown is the safety net, the symmetry is the fix.
USER node

# Documentation only — Render injects PORT and main.ts reads it.
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
