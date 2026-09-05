/**
 * `jig setup`: the onboarding wizard, wired to a terminal.
 *
 * Thin glue, in the same shape as the connect flow: `shared/setup-flow.ts` owns
 * the sequence and the rules, this file renders its events and supplies I/O.
 *
 * Two audiences, one code path:
 *
 *   - A human at a TTY gets prompts and an auto-opened browser.
 *   - A CODING AGENT gets the same flow with nothing to type. The required step
 *     is a browser authorization, so the agent prints a URL and waits for the
 *     human to click it; no secret ever passes through the agent. Nothing may
 *     block on readline in that mode, because an agent has no TTY and a blocked
 *     prompt looks exactly like a hang.
 *
 * The `--openrouter-key` / `--agentmail-key` / `--owner` flags are an escape
 * hatch for callers with no browser (CI, a scripted rebuild). They are applied
 * BEFORE the flow runs rather than fed to its prompts: a step that finds itself
 * already satisfied skips its own dialogue, so pre-seeding needs no second code
 * path inside the wizard.
 */
import { runSetupFlow, summarizeSetup, type SetupBackend, type SetupEvent, type SetupIO, type SetupFix } from "../../shared/setup-flow.js"
import type { Connection, ModelProbe, OpenRouterCredits, VerifyConnectionResponse } from "../../shared/api.js"
import { promptHiddenPassword } from "../cli-remote/unlock.js"

export interface SetupArgs {
  /** Explicit instance URL. Overrides the manifest and local defaults. */
  url?: string
  /** Remote handle from ~/.config/jig/remotes. */
  handle?: string
  openrouterKey?: string
  agentmailKey?: string
  owner?: string
  skipOptional: boolean
  /** Answer yes to every confirmation. Implied when there is no TTY. */
  assumeYes: boolean
  /** Provision a hosted Railway instance without asking which kind to make. */
  railway: boolean
  /** Set up a local instance instead of a hosted one. */
  local: boolean
  /** Walk every step even when the instance already reports itself ready. */
  force: boolean
}

export function setupHelp(): string {
  return `Usage: jig setup [handle] [options]

Guided setup for model access, failure alerts, and optional app connections.

Options:
  --railway              Provision and set up a hosted Railway instance
  --local                Set up this checkout's local instance
  --url=<url>            Set up an instance at an explicit URL
  --force                Re-check every setup step
  --skip-optional        Skip optional app connections
  --yes, -y              Accept setup confirmations
  --openrouter-key=<key> Non-browser fallback for OpenRouter
  --agentmail-key=<key>  Pre-seed AgentMail
  --owner=<email>        Alert recipient used with AgentMail
  --help, -h             Show this help`
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const valueFlags = ["url", "openrouter-key", "agentmail-key", "owner"]
  const booleanFlags = new Set(["--skip-optional", "--yes", "-y", "--railway", "--local", "--force"])
  for (const arg of argv) {
    if (!arg.startsWith("-")) continue
    if (booleanFlags.has(arg) || valueFlags.some((name) => arg.startsWith(`--${name}=`))) continue
    throw new Error(`Unknown setup option: ${arg}. Run \`jig setup --help\` for supported options.`)
  }
  if (argv.includes("--railway") && argv.includes("--local")) {
    throw new Error("Choose one setup target: --railway or --local, not both.")
  }
  if (argv.some((a) => a.startsWith("--url=")) && (argv.includes("--railway") || argv.includes("--local"))) {
    throw new Error("--url cannot be combined with --railway or --local.")
  }
  const handles = argv.filter((a) => !a.startsWith("-"))
  if (handles.length > 1) throw new Error("Setup accepts at most one instance handle.")

  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  return {
    url: flag("url"),
    handle: argv.find((a) => !a.startsWith("--")),
    openrouterKey: flag("openrouter-key") ?? process.env.JIG_OPENROUTER_KEY,
    agentmailKey: flag("agentmail-key") ?? process.env.JIG_AGENTMAIL_KEY,
    owner: flag("owner") ?? process.env.JIG_OWNER_EMAIL,
    skipOptional: argv.includes("--skip-optional"),
    assumeYes: argv.includes("--yes") || argv.includes("-y"),
    railway: argv.includes("--railway"),
    local: argv.includes("--local"),
    force: argv.includes("--force"),
  }
}

async function completeSetup(base: string, cookie?: string): Promise<void> {
  const res = await fetch(`${base}/api/onboarding/complete`, {
    method: "POST",
    headers: { ...(cookie ? { Cookie: cookie } : {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Could not mark setup complete (HTTP ${res.status}).`)
  }
}

const interactive = () => Boolean(process.stdin.isTTY)

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// Where the dashboard's model picker lives, once runSetup knows the dashboard URL.
let settingsUrl: string | undefined

/** The lines a failed step prints under its message when it knows what would fix it. */
function fixLines(fix: SetupFix): string[] {
  const lines: string[] = []
  if (fix.url) lines.push(`Fix: ${fix.label}: ${fix.url}`)
  if (fix.settings === "models") lines.push(`Or change the main model: ${settingsUrl ?? "dashboard Settings > Models"}`)
  return lines
}

function renderEvent(event: SetupEvent): void {
  switch (event.type) {
    case "plan":
      console.log("Setup steps:")
      for (const [i, s] of event.steps.entries()) {
        console.log(`  ${i + 1}. ${s.title}${s.required ? "" : "  (optional)"}`)
      }
      console.log("")
      break
    case "step-begin":
      console.log(`\n[${event.index}/${event.total}] ${event.title}`)
      break
    case "step-satisfied":
      console.log(`  already done: ${event.detail}`)
      break
    case "instruction":
      console.log(`  ${event.message}`)
      break
    case "open-url":
      console.log(
        event.opened
          ? `  Opened your browser to ${event.purpose}. If nothing appeared:\n    ${event.url}`
          : `  Open this to ${event.purpose}:\n    ${event.url}`,
      )
      break
    case "waiting":
      console.log(`  ${event.detail}...`)
      break
    case "verifying":
      console.log(`  verifying: ${event.detail}...`)
      break
    case "verified":
      // The level matters: a handshake proves credentials, a probe proves data.
      // Collapsing them would put us back to claiming things we did not check.
      console.log(`  ✓ ${event.summary}${event.level === "handshake" ? " (auth verified; no data probe configured)" : ""}`)
      break
    case "step-failed":
      console.log(`  ✗ ${event.message}`)
      if (event.fix) for (const line of fixLines(event.fix)) console.log(`    ${line}`)
      if (event.skippable) console.log(`    (optional, continuing)`)
      break
    case "step-skipped":
      console.log(`  skipped: ${event.reason}`)
      break
    case "recommendations":
      console.log(`  Worth adding next:`)
      for (const app of event.apps) console.log(`    - ${app.name}: ${app.why}`)
      if (event.dashboardUrl) console.log(`  Add them at ${event.dashboardUrl}, then re-run "jig setup".`)
      break
    case "complete":
      console.log(`\n  Setup complete. Verified: ${event.verified.join(", ") || "none"}.`)
      if (event.skipped.length) console.log(`  Skipped: ${event.skipped.join(", ")}.`)
      break
    case "error":
      console.error(`\n  ${event.message}`)
      break
  }
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function makeIO(args: SetupArgs): SetupIO {
  return {
    canPrompt: interactive,

    ask: async (question: string) => {
      if (!interactive()) {
        throw new Error(`Cannot prompt without a TTY. Supply it up front: --owner=<email>. (asked: ${question})`)
      }
      const { createInterface } = await import("node:readline/promises")
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(`  ${question}\n  > `)
      rl.close()
      return answer.trim()
    },

    askSecret: async (question: string) => {
      const hidden = await promptHiddenPassword(`  ${question.replace(/:$/, "")}`)
      if (hidden == null) {
        throw new Error(`No TTY to read a secret. Pass --agentmail-key=<key> (or set JIG_AGENTMAIL_KEY) and re-run. (asked: ${question})`)
      }
      return hidden
    },

    confirm: async (question: string) => {
      // No TTY means no one can answer. Treat that as "take the default path"
      // rather than hanging: optional steps are opt-in, so default to no.
      if (args.assumeYes) return true
      if (!interactive()) return false
      const { createInterface } = await import("node:readline/promises")
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(`  ${question} [Y/n] `)
      rl.close()
      return !answer.trim() || answer.trim().toLowerCase().startsWith("y")
    },

    openUrl: async (url: string) => {
      // No terminal means no person here to see a tab; print the link instead.
      if (!interactive()) return false
      try {
        const { default: open } = await import("open")
        await open(url)
        return true
      } catch {
        return false
      }
    },

    emit: renderEvent,
    wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  }
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

/**
 * HTTP backend. Works against a local `jig start` or a deployed instance; the
 * only difference is the base URL and whether a session cookie is attached.
 */
export function makeHttpBackend(base: string, cookie?: string): SetupBackend {
  const headers = (extra: Record<string, string> = {}) => ({
    ...extra,
    ...(cookie ? { Cookie: `jig-admin=${cookie}` } : {}),
  })

  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, { ...init, headers: headers(init?.headers as Record<string, string>) })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `${init?.method ?? "GET"} ${path} failed (HTTP ${res.status})`)
    }
    return res.json() as Promise<T>
  }

  return {
    openRouterCredits: async () => {
      const credits = await call<OpenRouterCredits | null>("/api/models/credits")
      // null means no key stored OR the key was rejected. Both are "not ready".
      if (!credits) return { ok: false, error: "No usable OpenRouter key on this instance." }
      return { ok: true, balance: credits.remaining }
    },

    probeMainModel: () => call<ModelProbe>("/api/models/probe", { method: "POST" }),

    startOpenRouterOAuth: () =>
      call<{ authorizationUrl: string; callbackUrl: string }>("/api/openrouter/oauth/start", { method: "POST" }),

    setOpenRouterKey: async (key: string) => {
      await call("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openrouter_key: key }),
      })
    },

    agentMailStatus: async () => {
      const s = await call<{ hasKey: boolean; owner: string | null; address: string | null; canSend: boolean; webhookReady: boolean }>(
        "/api/settings/agentmail",
      )
      return { hasKey: s.hasKey, owner: s.owner, address: s.address, canSend: s.canSend, webhookReady: s.webhookReady }
    },

    saveAgentMail: async (input) => {
      await call("/api/settings/agentmail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    },

    provisionAgentMailInbox: () =>
      call<{ ok: boolean; address?: string; webhookReady?: boolean; error?: string }>("/api/settings/agentmail/setup", { method: "POST" }),

    sendAgentMailTest: () => call<{ ok: boolean; error?: string }>("/api/settings/agentmail/test", { method: "POST" }),

    listConnections: () => call<Connection[]>("/api/connections"),

    connect: (name: string) =>
      call(`/api/connections/${encodeURIComponent(name)}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }) as ReturnType<SetupBackend["connect"]>,

    verify: (name: string) =>
      call<VerifyConnectionResponse>(`/api/connections/${encodeURIComponent(name)}/verify`, { method: "POST" }),
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------


/** Hosted or local, asked once, defaulting to hosted. */
async function askHosted(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  console.log("No Jig instance yet.")
  console.log("  Hosted on Railway keeps schedules running when your machine is off.")
  console.log("  Local runs only while `jig start` is running on this machine.")
  const answer = await rl.question("Provision a hosted instance on Railway? [Y/n] ")
  rl.close()
  return !answer.trim() || answer.trim().toLowerCase().startsWith("y")
}

/** A dashboard answers with HTML. The bare API server answers with a JSON 404. */
async function probeDashboard(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return res.headers.get("content-type")?.includes("text/html") ? url : undefined
  } catch {
    return undefined
  }
}

/**
 * Apply secrets passed by flag or env. Failures here are not fatal: the wizard
 * re-checks every one of these and will report the real problem in the step it
 * belongs to, with better wording than this function could manage.
 */
async function preseed(args: SetupArgs, backend: SetupBackend): Promise<void> {
  if (args.openrouterKey) {
    await backend.setOpenRouterKey(args.openrouterKey).catch(() => {})
  }
  if (args.agentmailKey || args.owner) {
    await backend
      .saveAgentMail({
        ...(args.agentmailKey ? { apiKey: args.agentmailKey } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
      })
      .catch(() => {})
  }
}

export async function runSetup(argv: string[], ensureLocalServer: () => Promise<string>): Promise<void> {
  const args = parseSetupArgs(argv)

  let base: string
  let cookie: string | undefined
  // Where a browser should go to finish a step by hand. Remote instances serve
  // the dashboard and the API off the same origin; locally they are two ports.
  let dashboardUrl: string | undefined

  if (args.url) {
    base = args.url.replace(/\/$/, "")
    dashboardUrl = base
  } else {
    const { listRemotes, resolveActiveRemote } = await import("../cli-remote/manifest.js")

    // No instance yet. Hosted is the answer we recommend, because a jig that
    // only runs while a laptop is open is not automation, so ask for it rather
    // than quietly standing up a local server and calling setup done.
    if (listRemotes().length === 0 && !args.local) {
      const provision = args.railway ? true : interactive() ? await askHosted() : null
      if (provision === null) {
        console.error(
          "No instance yet, and no terminal to ask which kind to make.\n" +
            "  Hosted (recommended): re-run with --railway, or run `jig deploy` first.\n" +
            "  Local:                re-run with --local.",
        )
        process.exit(1)
      }
      if (provision) {
        // Deploy asks its own questions and writes the remote manifest we then
        // set up against. It is interactive on purpose: it creates billed cloud
        // resources under whichever Railway account is active.
        const { runDeploy } = await import("../cli-deploy/index.js")
        await runDeploy()
        console.log("")
      }
    }

    if (listRemotes().length > 0 && !args.local) {
      const remote = resolveActiveRemote(args.handle)
      base = remote.public_url
      dashboardUrl = base
      console.log(`Setting up ${remote.handle} (${base}).\n`)
      const { ensureSession } = await import("../cli-remote/unlock.js")
      cookie = (await ensureSession(remote)) ?? undefined
      if (!cookie) {
        console.error(
          `This instance needs an admin session and there is no terminal to ask for the password.\n` +
            `  Set JIG_PASSWORD and re-run, or run \`jig unlock ${remote.handle}\` from a terminal first.`,
        )
        process.exit(1)
      }
    } else {
      base = await ensureLocalServer()
      // `jig setup` boots the API server but not Next, so the dashboard may not
      // be up. Offering a URL that answers {"error":"Unknown API route"} is
      // worse than admitting there is nowhere to send them.
      dashboardUrl = await probeDashboard(`http://localhost:${process.env.JIG_DASHBOARD_PORT ?? process.env.PORT ?? "3141"}`)
      console.log(`Setting up your local instance (${base}).\n`)
    }
  }

  settingsUrl = dashboardUrl ? `${dashboardUrl}/?view=settings&tab=models` : undefined
  const backend = makeHttpBackend(base, cookie)
  const io = makeIO(args)

  // A locked remote answers everything with 423, which would surface as a
  // confusing per-step failure. Checked before preseed, which writes credentials
  // and would itself 423. Normally unreachable now: signing in above unlocks the
  // instance, so this only fires when something else re-locked it since.
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { locked?: boolean } | null
  if (health?.locked) {
    console.error(`That instance is locked. Run "jig unlock" first, then re-run "jig setup".`)
    process.exit(1)
  }

  // Escape hatch, applied before the wizard rather than inside it: a step that
  // is already satisfied never opens its dialogue, so a caller with no browser
  // can still get through a step whose normal path is a browser.
  await preseed(args, backend)

  // The dashboard is the main way people set this up, so by the time anyone
  // reaches for the CLI the instance is often already done. Walking the wizard
  // then is not harmless: the alerts step proves itself by sending mail, so a
  // no-op run emails the owner. Report and stop instead.
  if (!args.force) {
    const state = await summarizeSetup(backend)
    const outstanding = state.filter((s) => s.required && !s.satisfied)
    if (outstanding.length === 0) {
      await completeSetup(base, cookie)
      console.log("Already set up. Nothing to do.\n")
      for (const s of state) {
        console.log(`  ${s.satisfied ? "\u2713" : "\u25CB"} ${s.id}: ${s.detail}`)
        if (!s.satisfied && s.fix) for (const line of fixLines(s.fix)) console.log(`      ${line}`)
      }
      const optional = state.filter((s) => !s.required && !s.satisfied)
      if (optional.length > 0) {
        console.log(`\n  Optional and not connected: ${optional.map((s) => s.id).join(", ")}.`)
      }
      console.log(`\n  Re-check or change anything on the dashboard's Setup page${dashboardUrl ? ` (${dashboardUrl}/?view=setup)` : ""}.`)
      console.log(`  Run \`jig setup --force\` to walk every step again.`)
      return
    }
  }

  try {
    await runSetupFlow(io, backend, {
      skipOptional: args.skipOptional || (!interactive() && !args.assumeYes),
      dashboardUrl,
    })
  } catch {
    // runSetupFlow already emitted step-failed + error, which the renderer
    // printed. Re-throwing would make cli.ts print the same line again.
    process.exit(1)
  }
  // Kept outside the flow catch: if persisting completion fails, cli.ts must
  // print that distinct error instead of silently treating it like a step that
  // already rendered its own failure.
  await completeSetup(base, cookie)
}
