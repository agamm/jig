/**
 * The onboarding wizard, as shared logic.
 *
 * Mirrors `connect-flow.ts`: this module owns the SEQUENCE and the rules, and
 * emits structured events. The CLI renders them as text, the dashboard renders
 * them as UI. Neither owns the ordering, so the two can't drift.
 *
 * Two rules drive the whole design:
 *
 *   1. ONE STEP AT A TIME. The wizard never presents a wall of choices. It
 *      runs the current step, reports the outcome, and only then moves on.
 *   2. A CONNECTION STEP ADVANCES ONLY ON PROOF. "Connected" is not enough,
 *      because a generated schema file outlives an expired token. Every
 *      connection step ends in a real call through `backend.verify`.
 *
 * Steps are resumable by construction: each one asks the backend whether it is
 * already satisfied before doing anything, so re-running setup after a failure
 * picks up where it stopped rather than redoing work or duplicating state.
 */
import type { Connection, VerifyConnectionResponse } from "./api"

export type SetupStepId = "openrouter" | "agentmail" | "composio"

export interface SetupStepInfo {
  id: SetupStepId
  title: string
  required: boolean
}

/**
 * The ordered wizard. AgentMail is required and comes before the optional
 * integrations because it is the channel Jig uses to tell you something broke:
 * without it, a failing jig fails silently. Composio follows because it is the
 * one connection that unlocks a long tail of others.
 */
export const SETUP_STEPS: SetupStepInfo[] = [
  { id: "openrouter", title: "Model access (OpenRouter)", required: true },
  { id: "agentmail", title: "Alerts and reply-to-edit (AgentMail)", required: true },
  { id: "composio", title: "App integrations (Composio)", required: false },
]

/** Apps worth adding once Composio is authorized, in recommendation order. */
export const COMPOSIO_RECOMMENDED_APPS = [
  { name: "Gmail", why: "read and send mail from a jig" },
  { name: "Google Calendar", why: "meeting-aware briefings and follow-ups" },
  { name: "Telegram or Slack", why: "get jig output where you already are" },
]

export type SetupEvent =
  | { type: "plan"; steps: SetupStepInfo[] }
  | { type: "step-begin"; id: SetupStepId; title: string; index: number; total: number }
  | { type: "step-satisfied"; id: SetupStepId; detail: string }
  | { type: "instruction"; message: string }
  | { type: "open-url"; url: string; purpose: string; opened: boolean }
  | { type: "waiting"; id: SetupStepId; detail: string }
  | { type: "verifying"; id: SetupStepId; detail: string }
  | { type: "verified"; id: SetupStepId; summary: string; level: "probe" | "handshake" | "asserted" }
  | { type: "step-failed"; id: SetupStepId; message: string; skippable: boolean }
  | { type: "step-skipped"; id: SetupStepId; reason: string }
  | { type: "recommendations"; apps: typeof COMPOSIO_RECOMMENDED_APPS; dashboardUrl?: string }
  | { type: "complete"; verified: SetupStepId[]; skipped: SetupStepId[] }
  | { type: "error"; code: string; message: string }

export interface SetupIO {
  /** Free-text answer (e.g. an email address). */
  ask(question: string): Promise<string>
  /** Secret answer; renderers must not echo it. */
  askSecret(question: string): Promise<string>
  confirm(question: string): Promise<boolean>
  /** Open a URL for the user. Returns false when no browser could be opened. */
  openUrl(url: string): Promise<boolean>
  emit(event: SetupEvent): void
  /** Injected so tests do not sleep. */
  wait(ms: number): Promise<void>
}

export interface SetupBackend {
  /** Credit balance doubles as the OpenRouter proof: a valid key with no credits still fails every model call. */
  openRouterCredits(): Promise<{ ok: boolean; balance?: number; error?: string }>
  setOpenRouterKey(key: string): Promise<void>
  agentMailStatus(): Promise<{ hasKey: boolean; owner: string | null; address: string | null; canSend: boolean; webhookReady: boolean }>
  saveAgentMail(input: { apiKey?: string; owner?: string }): Promise<void>
  provisionAgentMailInbox(): Promise<{ ok: boolean; address?: string; webhookReady?: boolean; error?: string }>
  sendAgentMailTest(): Promise<{ ok: boolean; error?: string }>
  listConnections(): Promise<Connection[]>
  connect(name: string): Promise<
    | { ok: true; server: string; toolCount: number; tools: string[] }
    | { ok: false; server: string; awaitingOAuth: true; authorizationUrl: string; browserOpened?: boolean }
    | { ok: false; server: string; missingCredentials: string[]; setup?: string }
  >
  verify(name: string): Promise<VerifyConnectionResponse>
}

export interface SetupOptions {
  /** Skip optional steps without asking. Used by non-interactive runs. */
  skipOptional?: boolean
  /** How long to wait for an OAuth callback before giving up. */
  oauthTimeoutMs?: number
  /** Poll interval while waiting for OAuth. */
  pollIntervalMs?: number
}

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

export async function runSetupFlow(
  io: SetupIO,
  backend: SetupBackend,
  options: SetupOptions = {},
): Promise<{ verified: SetupStepId[]; skipped: SetupStepId[] }> {
  const verified: SetupStepId[] = []
  const skipped: SetupStepId[] = []

  io.emit({ type: "plan", steps: SETUP_STEPS })

  for (const [index, step] of SETUP_STEPS.entries()) {
    io.emit({ type: "step-begin", id: step.id, title: step.title, index: index + 1, total: SETUP_STEPS.length })

    try {
      const outcome = await runStep(step, io, backend, options)
      if (outcome === "verified") verified.push(step.id)
      else skipped.push(step.id)
    } catch (error: any) {
      const message = error?.message ?? String(error)
      io.emit({ type: "step-failed", id: step.id, message, skippable: !step.required })
      if (step.required) {
        io.emit({ type: "error", code: "required-step-failed", message: `${step.title} is required. Fix the above and re-run setup.` })
        throw error
      }
      skipped.push(step.id)
    }
  }

  io.emit({ type: "complete", verified, skipped })
  return { verified, skipped }
}

type StepOutcome = "verified" | "skipped"

async function runStep(
  step: SetupStepInfo,
  io: SetupIO,
  backend: SetupBackend,
  options: SetupOptions,
): Promise<StepOutcome> {
  switch (step.id) {
    case "openrouter":
      return runOpenRouterStep(io, backend)
    case "agentmail":
      return runAgentMailStep(io, backend)
    case "composio":
      return runComposioStep(io, backend, options)
  }
}

/**
 * OpenRouter. Verification checks the BALANCE, not just the key: a fresh
 * account authenticates fine and then fails every model call, which reads as
 * "Jig is broken" rather than "top up your account".
 */
async function runOpenRouterStep(io: SetupIO, backend: SetupBackend): Promise<StepOutcome> {
  const existing = await backend.openRouterCredits()
  if (existing.ok) {
    io.emit({ type: "step-satisfied", id: "openrouter", detail: describeBalance(existing.balance) })
    io.emit({ type: "verified", id: "openrouter", summary: `openrouter: ${describeBalance(existing.balance)}`, level: "probe" })
    return "verified"
  }

  io.emit({ type: "instruction", message: "Jig needs an OpenRouter key for model calls." })
  const opened = await io.openUrl("https://openrouter.ai/keys")
  io.emit({ type: "open-url", url: "https://openrouter.ai/keys", purpose: "create an API key", opened })

  const key = (await io.askSecret("Paste your OpenRouter API key:")).trim()
  if (!key) throw new Error("An OpenRouter key is required.")
  await backend.setOpenRouterKey(key)

  io.emit({ type: "verifying", id: "openrouter", detail: "checking the key and credit balance" })
  const check = await backend.openRouterCredits()
  if (!check.ok) throw new Error(check.error ?? "OpenRouter rejected that key.")

  io.emit({ type: "verified", id: "openrouter", summary: `openrouter: ${describeBalance(check.balance)}`, level: "probe" })
  return "verified"
}

function describeBalance(balance: number | undefined): string {
  if (balance == null) return "key accepted"
  if (balance <= 0) return "key accepted, but the balance is 0. Top up or model calls will fail"
  return `key accepted, balance $${balance.toFixed(2)}`
}

/**
 * AgentMail. Required, because it is how an unattended Jig tells you a jig
 * broke. Verified by actually sending mail to the owner: that proves the key,
 * the inbox, AND that the owner address is real, which a key check alone does
 * not.
 */
async function runAgentMailStep(io: SetupIO, backend: SetupBackend): Promise<StepOutcome> {
  let status = await backend.agentMailStatus()

  if (!status.hasKey) {
    io.emit({
      type: "instruction",
      message: "AgentMail gives Jig a mailbox so it can email you when a jig fails, and so you can reply to fix it. Free tier, no card.",
    })
    const opened = await io.openUrl("https://console.agentmail.to")
    io.emit({ type: "open-url", url: "https://console.agentmail.to", purpose: "sign up and create an API key", opened })
    const apiKey = (await io.askSecret("Paste your AgentMail API key (starts with am_):")).trim()
    if (!apiKey) throw new Error("An AgentMail API key is required.")
    await backend.saveAgentMail({ apiKey })
    status = await backend.agentMailStatus()
  }

  if (!status.owner) {
    const owner = (await io.ask("Which email address should Jig send alerts to?")).trim()
    if (!owner.includes("@")) throw new Error("That does not look like an email address.")
    await backend.saveAgentMail({ owner })
  }

  if (!status.address) {
    io.emit({ type: "verifying", id: "agentmail", detail: "provisioning the Jig inbox" })
    const provisioned = await backend.provisionAgentMailInbox()
    if (!provisioned.ok) throw new Error(provisioned.error ?? "Could not provision an AgentMail inbox.")
    if (!provisioned.webhookReady) {
      // Send-only still means alerts work. Reply-to-edit is the part that needs
      // a publicly reachable URL, so say which half is missing rather than
      // implying the whole step failed.
      io.emit({ type: "instruction", message: "Inbox created for alerts. Reply-to-edit needs a public URL and is not wired up yet." })
    }
  }

  io.emit({ type: "verifying", id: "agentmail", detail: "sending a test email to the owner address" })
  const test = await backend.sendAgentMailTest()
  if (!test.ok) throw new Error(test.error ?? "AgentMail could not send a test email.")

  const finalStatus = await backend.agentMailStatus()
  io.emit({
    type: "verified",
    id: "agentmail",
    summary: `agentmail: test email sent to ${finalStatus.owner} from ${finalStatus.address}`,
    level: "probe",
  })

  // The free tier allows 3 inboxes total and Jig spends one per email-triggered
  // jig on top of this one. Better said now than discovered at the third jig.
  io.emit({ type: "instruction", message: "Free tier allows 3 inboxes. Jig uses one here, plus one per email-triggered jig." })
  return "verified"
}

/**
 * Composio. Optional but recommended: one OAuth unlocks a long tail of apps.
 * The server never opens a browser in service mode (it is a headless box), so
 * opening the authorization URL is the wizard's job.
 */
async function runComposioStep(io: SetupIO, backend: SetupBackend, options: SetupOptions): Promise<StepOutcome> {
  const connections = await backend.listConnections()
  const composio = connections.find((c) => c.name === "composio")
  if (!composio) {
    io.emit({ type: "step-skipped", id: "composio", reason: "Composio is not in this instance's connection registry." })
    return "skipped"
  }

  if (!composio.connected) {
    if (!options.skipOptional) {
      const wanted = await io.confirm("Connect Composio now? It adds Gmail, Calendar, Slack, Telegram and 250+ apps.")
      if (!wanted) {
        io.emit({ type: "step-skipped", id: "composio", reason: "Declined for now. Run `jig connect composio` later." })
        return "skipped"
      }
    } else {
      io.emit({ type: "step-skipped", id: "composio", reason: "Optional step skipped in non-interactive mode." })
      return "skipped"
    }

    const result = await backend.connect("composio")
    if (!result.ok && "awaitingOAuth" in result) {
      const opened = await io.openUrl(result.authorizationUrl)
      io.emit({ type: "open-url", url: result.authorizationUrl, purpose: "authorize Composio", opened })
      await waitForConnected(io, backend, "composio", options)
    } else if (!result.ok) {
      throw new Error(`Composio needs credentials this wizard cannot supply: ${result.missingCredentials.join(", ")}`)
    }
  }

  io.emit({ type: "verifying", id: "composio", detail: "checking the connection responds" })
  const verification = await backend.verify("composio")
  if (!verification.ok) throw new Error(verification.error)
  io.emit({ type: "verified", id: "composio", summary: verification.summary, level: verification.level })

  io.emit({
    type: "recommendations",
    apps: COMPOSIO_RECOMMENDED_APPS,
    dashboardUrl: composio.proxyDashboardUrl,
  })
  return "verified"
}

/**
 * Poll until the OAuth callback lands. The connect request returns as soon as
 * the URL is staged, so the browser dance completes out of band and the only
 * way to know is to watch the connection flip.
 */
async function waitForConnected(
  io: SetupIO,
  backend: SetupBackend,
  name: string,
  options: SetupOptions,
): Promise<void> {
  const timeoutMs = options.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  io.emit({ type: "waiting", id: name as SetupStepId, detail: "waiting for you to finish authorizing in the browser" })

  while (Date.now() < deadline) {
    await io.wait(intervalMs)
    const connections = await backend.listConnections()
    if (connections.find((c) => c.name === name)?.connected) return
  }
  throw new Error(`Timed out waiting for ${name} authorization. Re-run setup to try again.`)
}
