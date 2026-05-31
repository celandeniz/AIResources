# One image for all three Node services (api, worker, web). Built once, reused
# via a shared image tag in docker-compose; each service overrides `command`.
FROM node:22-bookworm-slim

# Prisma needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Copy the whole monorepo (node_modules excluded via .dockerignore).
COPY . .

RUN pnpm install --no-frozen-lockfile

# Build shared → db (generates Prisma client) → api → worker → web.
RUN pnpm --filter @dynops/shared build \
 && pnpm --filter @dynops/db build \
 && pnpm --filter @dynops/api build \
 && pnpm --filter @dynops/worker build \
 && pnpm --filter @dynops/web build

# Default command (overridden per service in docker-compose).
CMD ["node", "services/api/dist/main.js"]
