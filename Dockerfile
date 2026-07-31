FROM oven/bun:1.3.9 AS build

WORKDIR /app

# Install the engine and dashboard dependencies before copying source so normal
# source changes can reuse the dependency layers.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

RUN bun install --global pnpm
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

FROM oven/bun:1.3.9

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

CMD ["bun", "run", "src/cli.ts", "start"]
