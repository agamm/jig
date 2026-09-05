# Jig Dashboard

The dashboard is Jig's Next.js frontend. It is served alongside the Bun API; it is not a
standalone app and should not be deployed to Vercel.

## Run locally

From the repository root:

```sh
bun install
bun run jig start
```

Open <http://localhost:3141>. This starts the Bun API on an internal loopback port and the
Next.js dashboard on port 3141. It also installs dashboard dependencies with pnpm when needed.

Use pnpm, not bun, for dashboard-only package commands:

```sh
cd dashboard
pnpm install
pnpm run build
./node_modules/.bin/tsc --noEmit
```

Running `pnpm run dev` by itself starts only the frontend. Its `/api/*` proxy still requires a
Bun API at `JIG_API_PORT` (4173 by default), so the root `bun run jig start` command is the
normal development path.

## Architecture

The dashboard is a thin UI and proxy. `src/proxy.ts` forwards `/api/*` to the co-located Bun
server; backend logic, model calls, database access, and filesystem access belong in the root
`src/server.ts`, not in Next.js routes or middleware.

See [`DASHBOARD.md`](DASHBOARD.md) for the component map and design conventions, and the root
[`README.md`](../README.md) for setup and Railway deployment.
