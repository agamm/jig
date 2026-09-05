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

Jig needs OpenRouter for model calls and AgentMail for failure alerts and
reply-to-edit. OpenRouter uses browser OAuth: the instance receives its own key,
so it is not a Railway variable and there is nothing to paste. AgentMail has no
OAuth server; the Setup page guides the owner through creating and entering its
key, then verifies it by sending a real message. External connections such as
Gmail, Calendar, GitHub, Apify, or Composio are optional.

### Deployment Dependencies

- Public container image: `ghcr.io/agamm/jig:latest`
- One blank Railway volume mounted at `/data`
- One Railway-provided public domain
- No preconfigured variables, registry credentials, or maintainer data

## First Run

After deployment:

1. open the service logs and copy the one-time setup code;
2. open the generated Railway domain, enter that code, and create the instance password;
3. on **Setup**, authorize OpenRouter in the browser; setup verifies that it has credit;
4. follow the guided AgentMail step and verify the owner email;
5. optionally authorize Composio and connect the services your workflows need;
6. under **Connect the CLI**, generate and run the single-use pairing command;
7. give the first-jig prompt to a coding agent, then review and approve its pending TypeScript.

The setup code claims a new public instance and appears only in its service logs. Do not share
it. The later CLI pairing code is a different, single-use code generated from the Setup page.

The `/data` volume stores your encrypted credentials, versioned jigs, schedules,
and run history across redeploys.

## Operate Jig

- Health: `GET /api/health`
- Update a template install: redeploy from the latest image in Railway
- Update from a linked checkout: `bun run jig deploy --update`
- Diagnose: `bun run jig doctor`
- Remote logs and test runs: `bun run jig debug`

See `docs/operations.md` in the repository for the full deployment and recovery runbook.
