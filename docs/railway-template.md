# Jig

Deploy a clean, always-on Jig instance.

The template provisions:

- one Jig service built from the public repository;
- the checked-in Railway health, restart, and start configuration;
- a blank persistent volume mounted at `/data`;
- public networking for the dashboard and API.

No maintainer data is copied. The template contains no database, credentials, OAuth state, environment secrets, connected accounts, generated schemas, logs, or personal configuration.

## First run

After deployment:

1. open the generated Railway domain;
2. create the instance password;
3. add your OpenRouter API key in Settings;
4. connect the services your workflows need;
5. describe a jig, review its TypeScript, and approve it.

The `/data` volume stores your encrypted credentials, versioned jigs, schedules, and run history across redeploys.

## Operate

- Health: `GET /api/health`
- Update from a linked checkout: `bun run jig deploy --update`
- Diagnose: `bun run jig doctor`
- Remote logs and test runs: `bun run jig debug`

See `docs/operations.md` in the repository for the full deployment and recovery runbook.
