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
 *   3. NOTHING IS LEFT TO THE READER. Where a step can be an authorization, it
 *      is one and no key is ever seen (OpenRouter, Composio). Where it cannot
 *      be, the wizard walks the user through it click by click rather than
 *      naming a service and wishing them luck. AgentMail is that case: it
 *      publishes no authorization server, so setup opens the console, says what
 *      to click, and takes the key wherever the user can give it, including a
 *      browser when there is no terminal to type into.
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
  /**
   * Whether a human can answer a prompt right now. False under a coding agent
   * or any other TTY-less caller, where `ask`/`askSecret` would throw rather
   * than return. Steps use it to choose a browser path over a paste path.
   */
  canPrompt(): boolean
  emit(event: SetupEvent): void
  /** Injected so tests do not sleep. */
  wait(ms: number): Promise<void>
}

export interface SetupBackend {
  /** Credit balance doubles as the OpenRouter proof: a valid key with no credits still fails every model call. */
  openRouterCredits(): Promise<{ ok: boolean; balance?: number; error?: string }>
  setOpenRouterKey(key: string): Promise<void>
  /** Stage an OpenRouter PKCE authorization; the key arrives at the callback, not here. */
  startOpenRouterOAuth(): Promise<{ authorizationUrl: string }>
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

/**
 * Straight to the page that mints the key. Note the console 404s every app route
 * for a signed-out visitor rather than redirecting to sign-in, so step 1 names
 * that instead of leaving someone staring at a 404 thinking the link is broken.
 */
const AGENTMAIL_CONSOLE_URL = "https://console.agentmail.to/dashboard/api-keys"
const AGENTMAIL_STEPS = [
  "1. Signed out? That page 404s. Sign up at console.agentmail.to first (free tier, no card), then come back to it.",
  "2. Click Create New API Key and name it \"jig\".",
  "3. Copy it now: AgentMail shows a key once and never again.",
]

export interface SetupOptions {
  /** Skip optional steps without asking. Used by non-interactive runs. */
  skipOptional?: boolean
  /** How long to wait for an OAuth callback before giving up. */
  oauthTimeoutMs?: number
  /** Poll interval while waiting for OAuth. */
  pollIntervalMs?: number
  /**
   * Where this instance's dashboard lives. Used to hand a step off to a browser
   * when there is no terminal to type into.
   */
  dashboardUrl?: string
  /**
   * Run only these steps. The dashboard uses it so a card that says "needs
   * attention" can offer a button that fixes only that thing, instead of making
   * someone re-walk the steps that already pass.
   */
  only?: SetupStepId[]
}

const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_INTERVAL_MS = 2_000

/** What each step reports when asked, without doing anything about it. */
export interface SetupStepState {
  id: SetupStepId
  required: boolean
  satisfied: boolean
  detail: string
}

/**
 * Read-only "where does this instance stand".
 *
 * Separate from `runSetupFlow` because asking is not the same as fixing: the
 * wizard's agentmail step proves itself by SENDING mail, so re-running it on a
 * finished instance mails the owner for no reason. Callers that only want to
 * know (the CLI deciding whether to bother, the dashboard drawing its cards) ask
 * here, and the rules for "satisfied" stay in one place either way.
 */
export async function summarizeSetup(backend: SetupBackend): Promise<SetupStepState[]> {
  const [credits, mail, connections] = await Promise.all([
    backend.openRouterCredits().catch(() => ({ ok: false, error: "Could not reach the instance." })),
    backend.agentMailStatus().catch(() => null),
    backend.listConnections().catch(() => [] as Connection[]),
  ])

  const composio = connections.find((c) => c.name === "composio")
  const byId: Record<SetupStepId, { satisfied: boolean; detail: string }> = {
    openrouter: {
      satisfied: credits.ok,
      detail: credits.ok ? describeBalance((credits as { balance?: number }).balance) : ((credits as { error?: string }).error ?? "No usable key yet."),
    },
    agentmail: {
      satisfied: Boolean(mail?.canSend && mail.owner),
      detail: mail?.canSend
        ? `alerts go to ${mail.owner} from ${mail.address}`
        : mail?.hasKey
          ? "Key saved, but the inbox is not sending yet."
          : "No AgentMail key yet.",
    },
    composio: {
      // Authorized with nothing inside it is the state most easily mistaken for
      // working: the connection is green, every jig that needs Gmail still
      // fails. A proxy with no tools is not a satisfied step.
      satisfied: Boolean(composio?.connected && composio.toolCount > 0),
      detail: !composio
        ? "Not in this instance's registry."
        : !composio.connected
          ? "Not connected."
          : composio.toolCount > 0
            ? `connected, ${composio.toolCount} tools`
            : "Authorized, but no apps connected inside it yet, so it has 0 tools.",
    },
  }

  return SETUP_STEPS.map((step) => ({ id: step.id, required: step.required, ...byId[step.id] }))
}

export async function runSetupFlow(
  io: SetupIO,
  backend: SetupBackend,
  options: SetupOptions = {},
): Promise<{ verified: SetupStepId[]; skipped: SetupStepId[] }> {
  const verified: SetupStepId[] = []
  const skipped: SetupStepId[] = []

  const steps = options.only ? SETUP_STEPS.filter((s) => options.only!.includes(s.id)) : SETUP_STEPS
  io.emit({ type: "plan", steps })

  for (const [index, step] of steps.entries()) {
    io.emit({ type: "step-begin", id: step.id, title: step.title, index: index + 1, total: steps.length })

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
      return runOpenRouterStep(io, backend, options)
    case "agentmail":
      return runAgentMailStep(io, backend, options)
    case "composio":
      return runComposioStep(io, backend, options)
  }
}

/**
 * OpenRouter, via the PKCE flow: the user authorizes in a browser and the key
 * is delivered to the instance's callback. Nobody creates a key, copies it, or
 * pastes it, which also means a coding agent driving setup never handles a
 * secret it should not have.
 *
 * Verification checks the BALANCE, not just the key: a fresh account
 * authenticates fine and then fails every model call, which reads as "Jig is
 * broken" rather than "top up your account".
 */
async function runOpenRouterStep(io: SetupIO, backend: SetupBackend, options: SetupOptions): Promise<StepOutcome> {
  const existing = await backend.openRouterCredits()
  if (existing.ok) {
    io.emit({ type: "step-satisfied", id: "openrouter", detail: describeBalance(existing.balance) })
    io.emit({ type: "verified", id: "openrouter", summary: `openrouter: ${describeBalance(existing.balance)}`, level: "probe" })
    return "verified"
  }

  io.emit({ type: "instruction", message: "Jig needs an OpenRouter account for model calls. Authorize it in the browser; no key to copy." })
  const { authorizationUrl } = await backend.startOpenRouterOAuth()
  const opened = await io.openUrl(authorizationUrl)
  io.emit({ type: "open-url", url: authorizationUrl, purpose: "authorize OpenRouter", opened })

  const check = await waitForOpenRouterKey(io, backend, options)
  io.emit({ type: "verified", id: "openrouter", summary: `openrouter: ${describeBalance(check.balance)}`, level: "probe" })
  return "verified"
}

/**
 * Poll until the callback has stored a key. The authorization completes out of
 * band in the browser, so the balance check is the only signal that it landed,
 * and it doubles as the proof the step needs.
 */
async function waitForOpenRouterKey(
  io: SetupIO,
  backend: SetupBackend,
  options: SetupOptions,
): Promise<{ ok: boolean; balance?: number; error?: string }> {
  const timeoutMs = options.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  io.emit({ type: "waiting", id: "openrouter", detail: "waiting for you to authorize OpenRouter in the browser" })

  while (Date.now() < deadline) {
    await io.wait(intervalMs)
    const check = await backend.openRouterCredits()
    if (check.ok) return check
  }
  throw new Error("Timed out waiting for OpenRouter authorization. Re-run setup to try again.")
}

function describeBalance(balance: number | undefined): string {
  if (balance == null) return "key accepted"
  if (balance <= 0) return "key accepted, but the balance is 0. Top up or model calls will fail"
  return `key accepted, balance $${balance.toFixed(2)}`
}

/**
 * AgentMail: how an unattended Jig tells you a jig broke. Verified by actually
 * sending mail to the owner, which proves the key, the inbox, AND that the owner
 * address is real; a key check alone proves none of that.
 *
 * Optional, reluctantly. AgentMail publishes no authorization server (no
 * `/.well-known/oauth-authorization-server`, no authorize endpoint), so its key
 * can only be created in a console and pasted. Requiring it would put a paste
 * back in the middle of the default path, so instead the step offers itself and
 * says plainly what staying without it costs.
 */
async function runAgentMailStep(io: SetupIO, backend: SetupBackend, options: SetupOptions): Promise<StepOutcome> {
  let status = await backend.agentMailStatus()

  if (!status.hasKey || !status.owner) {
    io.emit({
      type: "instruction",
      message: "AgentMail gives Jig a mailbox so it can email you when a jig fails, and so you can reply to fix it. Free tier, no card.",
    })
    // Spelled out click by click. "Create an API key" is where people stall, and
    // the one that matters is the last line: the key is shown exactly once.
    for (const line of AGENTMAIL_STEPS) io.emit({ type: "instruction", message: line })
    const opened = await io.openUrl(AGENTMAIL_CONSOLE_URL)
    io.emit({ type: "open-url", url: AGENTMAIL_CONSOLE_URL, purpose: "create an API key", opened })

    if (io.canPrompt()) {
      if (!status.hasKey) {
        const apiKey = (await io.askSecret("Paste your AgentMail API key (starts with am_):")).trim()
        if (!apiKey) throw new Error("An AgentMail API key is required.")
        await backend.saveAgentMail({ apiKey })
      }
      if (!status.owner) {
        const owner = (await io.ask("Which email address should Jig send alerts to?")).trim()
        if (!owner.includes("@")) throw new Error("That does not look like an email address.")
        await backend.saveAgentMail({ owner })
      }
      status = await backend.agentMailStatus()
    } else {
      // No terminal to paste into. The dashboard has the same two fields, so the
      // step continues in the browser rather than failing at the one thing that
      // cannot be an authorization.
      status = await waitForAgentMailInBrowser(io, backend, options)
    }
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
 * Finish AgentMail in the dashboard.
 *
 * Reached when nothing can be typed at the caller (a coding agent, a script).
 * The dashboard collects the key and the owner address on one screen, so the
 * wizard sends the user there and waits for the server to report both, rather
 * than failing a required step over the absence of a terminal.
 */
async function waitForAgentMailInBrowser(
  io: SetupIO,
  backend: SetupBackend,
  options: SetupOptions,
): Promise<Awaited<ReturnType<SetupBackend["agentMailStatus"]>>> {
  const dashboard = options.dashboardUrl
  if (!dashboard) {
    throw new Error(
      "AgentMail needs a key and an owner address. There is no terminal to ask on, and no dashboard running to collect them in. Start one with `jig start` and re-run setup, or pass --agentmail-key=<key> and --owner=<email>.",
    )
  }

  const settingsUrl = `${dashboard.replace(/\/$/, "")}/?view=settings&tab=notifications`
  const opened = await io.openUrl(settingsUrl)
  io.emit({ type: "open-url", url: settingsUrl, purpose: "paste the key and your alert address into Jig", opened })
  io.emit({ type: "waiting", id: "agentmail", detail: "waiting for the AgentMail key and owner address to be saved" })

  const timeoutMs = options.oauthTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await io.wait(intervalMs)
    const status = await backend.agentMailStatus()
    if (status.hasKey && status.owner) return status
  }
  throw new Error(
    "Timed out waiting for AgentMail. Save the key and your alert address in the dashboard under Settings, Notifications, then re-run setup.",
  )
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
