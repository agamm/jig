FROM oven/bun:1.3.9 AS bun-bin

FROM node:22-bookworm-slim AS build

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install the engine and dashboard dependencies before copying source so normal
# source changes can reuse the dependency layers.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

RUN npm install --global pnpm@10.15.1
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./dashboard/
RUN cd dashboard && pnpm install --frozen-lockfile

# Deliberate allowlist: only runtime source and public example/config assets are
# included. Local state, credentials, logs, and documentation never enter the
# container build context.
COPY tsconfig.json ./
COPY src ./src
COPY shared ./shared
COPY dashboard ./dashboard
COPY examples ./examples
COPY servers ./servers

RUN cd dashboard && ./node_modules/.bin/next build

FROM node:22-bookworm-slim

COPY --from=bun-bin /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app /app

CMD ["bun", "run", "src/cli.ts", "start"]
