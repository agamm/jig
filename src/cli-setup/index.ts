/**
 * `jig setup`: the onboarding wizard, wired to a terminal.
 *
 * Thin glue, in the same shape as the connect flow: `shared/setup-flow.ts` owns
 * the sequence and the rules, this file renders its events and supplies I/O.
 *
 * Two audiences, one code path:
 *
 *   - A human at a TTY gets prompts and an auto-opened browser.
 *   - A CODING AGENT gets the same flow with every secret supplied up front by
 *     flag or env. Nothing may block on readline in that mode, because an agent
 *     has no TTY and a blocked prompt looks exactly like a hang. When a secret
 *     is missing and we cannot ask, we fail with the flag to pass rather than
 *     waiting for input that will never arrive.
 */
import { runSetupFlow, type SetupBackend, type SetupEvent, type SetupIO } from "../../shared/setup-flow.js"
import type { Connection, OpenRouterCredits, VerifyConnectionResponse } from "../../shared/api.js"
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
}

export function parseSetupArgs(argv: string[]): SetupArgs {
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  return {
    url: flag("url"),
    handle: argv.find((a) => !a.startsWith("--")),
    openrouterKey: flag("openrouter-key") ?? process.env.JIG_OPENROUTER_KEY,
    agentmailKey: flag("agentmail-key") ?? process.env.JIG_AGENTMAIL_KEY,
    owner: flag("owner") ?? process.env.JIG_OWNER_EMAIL,
    skipOptional: argv.includes("--skip-optional"),
    assumeYes: argv.includes("--yes") || argv.includes("-y"),
  }
}

const interactive = () => Boolean(process.stdin.isTTY)

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

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
  // Secrets supplied up front are consumed in order of demand. This is what
  // lets an agent run the whole wizard without a TTY.
  const supplied = new Map<string, { value?: string; flag: string; env: string }>([
    ["OpenRouter", { value: args.openrouterKey, flag: "--openrouter-key=<key>", env: "JIG_OPENROUTER_KEY" }],
    ["AgentMail", { value: args.agentmailKey, flag: "--agentmail-key=<key>", env: "JIG_AGENTMAIL_KEY" }],
  ])

  return {
    ask: async (question: string) => {
      if (/email address should Jig send/i.test(question) && args.owner) return args.owner
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
      const entry = [...supplied.entries()].find(([label]) => question.includes(label))
      if (entry) {
        const [label, spec] = entry
        if (spec.value) {
          supplied.set(label, { ...spec, value: undefined }) // single use, so a retry re-prompts
          return spec.value
        }
      }
      const hidden = await promptHiddenPassword(`  ${question.replace(/:$/, "")}`)
      if (hidden == null) {
        // Name ONLY the flag that is actually missing. Listing every flag makes
        // the reader hunt for which one applies to the step that just failed.
        const spec = entry?.[1]
        throw new Error(
          spec
            ? `No TTY to read the ${entry![0]} key. Pass ${spec.flag} (or set ${spec.env}) and re-run.`
            : `No TTY to read a secret, and none was supplied up front. (asked: ${question})`,
        )
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

export async function runSetup(argv: string[], ensureLocalServer: () => Promise<string>): Promise<void> {
  const args = parseSetupArgs(argv)

  let base: string
  let cookie: string | undefined

  if (args.url) {
    base = args.url.replace(/\/$/, "")
  } else {
    const { listRemotes, resolveActiveRemote } = await import("../cli-remote/manifest.js")
    if (listRemotes().length > 0) {
      const remote = resolveActiveRemote(args.handle)
      base = remote.public_url
      cookie = remote.session_cookie
      console.log(`Setting up ${remote.handle} (${base}).\n`)
    } else {
      base = await ensureLocalServer()
      console.log(`Setting up your local instance (${base}).\n`)
    }
  }

  const backend = makeHttpBackend(base, cookie)
  const io = makeIO(args)

  // A locked remote answers everything with 423, which would surface as a
  // confusing per-step failure. Say the real thing instead.
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { locked?: boolean } | null
  if (health?.locked) {
    console.error(`That instance is locked. Run "jig unlock" first, then re-run "jig setup".`)
    process.exit(1)
  }

  try {
    await runSetupFlow(io, backend, { skipOptional: args.skipOptional || (!interactive() && !args.assumeYes) })
  } catch {
    // runSetupFlow already emitted step-failed + error, which the renderer
    // printed. Re-throwing would make cli.ts print the same line again.
    process.exit(1)
  }
}
