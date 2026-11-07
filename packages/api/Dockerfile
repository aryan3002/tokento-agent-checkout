# Tokento API for the hosted demo (Azure Container Apps). Build from the repo root:
#   docker build -f packages/api/Dockerfile .
# Runs migrations, then the API on $PORT (4000). Redis runs as a sidecar container.
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/paypal/package.json packages/paypal/
COPY packages/api/package.json packages/api/
RUN pnpm install --frozen-lockfile --filter "@tokento/api..."

COPY packages/shared packages/shared
COPY packages/paypal packages/paypal
COPY packages/api packages/api
RUN pnpm --filter @tokento/api exec prisma generate \
 && pnpm --filter @tokento/shared build \
 && pnpm --filter @tokento/paypal build \
 && pnpm --filter @tokento/api build

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "cd packages/api && npx prisma migrate deploy && node dist/index.js"]
