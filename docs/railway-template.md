# Deploy and Host Jig

Deploy a clean, always-on Jig instance.

## About Hosting

The template provisions:

- one Jig service from the public `ghcr.io/agamm/jig:latest` image;
- a health check at `/api/health` and an always-restart policy;
- a blank persistent volume mounted at `/data`;
- public networking for the dashboard and API.

The image is built from the public repository by GitHub Actions. Its Dockerfile
uses an explicit runtime-file allowlist, and its build context excludes local
state and secrets.

No maintainer data is copied. The template has no variables and contains no
database, credentials, OAuth state, environment secrets, connected accounts,
generated schemas, logs, or personal configuration.

## Why Deploy Jig on Railway

- Keep scheduled workflows running when a local machine is offline.
- Persist encrypted credentials, versioned jigs, schedules, and run history.
- Get a managed public HTTPS endpoint with an automated health check.
- Update from the same privacy-safe public image used by the template.

## Common Use Cases

- Draft thoughtful follow-ups after meetings.
- Surface people worth congratulating or reconnecting with.
- Run recurring briefings, monitoring, triage, and reporting workflows.
- Build approval-gated automations with scoped MCP tools.

## Dependencies for Jig Hosting

Jig needs an OpenRouter account for model calls. Authorize it inside Jig after
first unlock and the instance receives its own key; it is not a Railway template
variable and there is nothing to paste. External connections such as Gmail,
Calendar, GitHub, Apify, or Composio are optional and are connected by each
deployer from the dashboard.

### Deployment Dependencies

- Public container image: `ghcr.io/agamm/jig:latest`
- One blank Railway volume mounted at `/data`
- One Railway-provided public domain
- No preconfigured variables, registry credentials, or maintainer data

## First Run

After deployment:

1. open the generated Railway domain;
2. create the instance password;
3. authorize OpenRouter when prompted;
4. connect the services your workflows need;
5. describe a jig, review its TypeScript, and approve it.

The `/data` volume stores your encrypted credentials, versioned jigs, schedules,
and run history across redeploys.

## Operate Jig

- Health: `GET /api/health`
- Update a template install: redeploy from the latest image in Railway
- Update from a linked checkout: `bun run jig deploy --update`
- Diagnose: `bun run jig doctor`
- Remote logs and test runs: `bun run jig debug`

See `docs/operations.md` in the repository for the full deployment and recovery runbook.
