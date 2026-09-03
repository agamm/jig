# Jig Agent Instructions

Start with [`llms.txt`](llms.txt). It routes each task to the smallest authoritative guide.

- Running an instance (install, setup, connect, Railway deploy, update): read [`.agents/skills/jig/SKILL.md`](.agents/skills/jig/SKILL.md).
- Writing or editing a jig: read [`SKILL.md`](SKILL.md) completely before changing workflow code.
- Modifying Jig itself: follow [`CLAUDE.md`](CLAUDE.md), including its privacy, database, architecture, and verification rules.
- Deploying, diagnosing, or recovering an instance: follow [`docs/operations.md`](docs/operations.md).

Never commit credentials, personal data, runtime databases, generated connection files, logs, or deployment state. The ignored `.env`, `.jig/`, `jigs/`, `jig.db*`, `jig.log`, `runtime/`, and `tmp/` paths are local or instance data, not source.

Author workflows through the dashboard or `bun run jig new|edit`. SQLite is the only source of truth for jig code — nothing reads jig source off disk.
