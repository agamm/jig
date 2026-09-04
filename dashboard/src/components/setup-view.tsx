"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { mutate } from "swr";
import { Button, buttonClasses } from "@/components/button";
import { TextInput, secretFieldProps } from "@/components/input";
import { PaneHeader } from "@/components/pane-header";
import { ServiceIcon } from "@/components/service-icon";
import { ShimmerText } from "@/components/shimmer-text";
import { Spinner } from "@/components/spinner";
import { Notice } from "@/components/state-panel";
import {
  completeOnboarding,
  createPairingCode,
  fetchPairingStatus,
  connectConnection,
  fetchAgentMailSettings,
  fetchConnections,
  fetchHealth,
  fetchOpenRouterCredits,
  probeMainModel,
  saveAgentMailSettings,
  sendAgentMailTest,
  setupAgentMail,
  startOpenRouterOAuth,
  verifyConnection,
} from "@/lib/api";
import type { HealthResponse } from "@shared/api";
import {
  SETUP_STEPS,
  runSetupFlow,
  summarizeSetup,
  type SetupBackend,
  type SetupEvent,
  type SetupFix,
  type SetupIO,
  type SetupStepId,
} from "@shared/setup-flow";

/**
 * The setup page.
 *
 * It runs `runSetupFlow` — the exact function `jig setup` runs — and renders its
 * events instead of printing them. That is the point: the ordering, the rules
 * for what counts as satisfied, and the "advance only on proof" behaviour live
 * in one shared module, so the terminal and this page cannot drift apart.
 *
 * What the browser adds is the things a terminal cannot do well: the OAuth
 * hand-off happens in a tab the user is already signed into, and the one step
 * that needs a pasted key collects it in a form instead of a hidden prompt.
 */

type StepState = {
  status: "unknown" | "checking" | "waiting" | "ready" | "failed" | "skipped";
  detail?: string;
  authUrl?: string;
  /** The browser refused to open the tab, so the link is the only way through. */
  blocked?: boolean;
  /** What to click when the step failed for a reason setup cannot fix itself. */
  fix?: SetupFix;
};

type Prompt = {
  stepId: SetupStepId;
  question: string;
  secret: boolean;
  resolve: (value: string) => void;
  reject: (reason: Error) => void;
};

const INITIAL: Record<SetupStepId, StepState> = {
  openrouter: { status: "unknown" },
  agentmail: { status: "unknown" },
  composio: { status: "unknown" },
};

const STEP_BLURB: Record<SetupStepId, string> = {
  openrouter: "Runs every llm() and agent() call. Authorize once; the key is delivered to this instance and never shown to you.",
  agentmail: "How a failing jig reaches you, and how replying to that mail edits the jig. Needs a key from the AgentMail console.",
  composio: "One authorization for Gmail, Calendar, Slack, Telegram and a long tail of other apps.",
};

const APPROVAL_HIGHLIGHT_MS = 1_800;

function statusPill(state: StepState) {
  const map: Record<StepState["status"], { label: string; className: string }> = {
    unknown: { label: "not checked", className: "border-[#2a2a2e] text-[var(--text-dim)]" },
    checking: { label: "checking", className: "border-sky-500/30 bg-sky-500/[0.08] text-sky-200" },
    waiting: { label: "waiting for you", className: "border-amber-500/30 bg-amber-500/[0.08] text-amber-200" },
    ready: { label: "ready", className: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-200" },
    failed: { label: "needs attention", className: "border-rose-500/30 bg-rose-500/[0.08] text-rose-200" },
    skipped: { label: "skipped", className: "border-[#2a2a2e] text-[var(--text-dim)]" },
  };
  const { label, className } = map[state.status];
  return (
    <span className={`shrink-0 rounded-full border px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.1em] ${className}`}>
      {label}
    </span>
  );
}

/**
 * Just the reads `summarizeSetup` performs. The write paths are supplied
 * separately when the wizard actually runs, so a passive status check cannot
 * accidentally change anything.
 */
function readOnlyBackend(): SetupBackend {
  const unused = () => {
    throw new Error("read-only backend");
  };
  return {
    openRouterCredits: async () => {
      const credits = await fetchOpenRouterCredits().catch(() => null);
      return credits ? { ok: true, balance: credits.remaining } : { ok: false, error: "No usable OpenRouter key yet." };
    },
    agentMailStatus: async () => {
      const s = await fetchAgentMailSettings();
      return { hasKey: s.hasKey, owner: s.owner, address: s.address, canSend: s.canSend, webhookReady: s.webhookReady };
    },
    probeMainModel: () => probeMainModel(),
    listConnections: () => fetchConnections(),
    startOpenRouterOAuth: unused,
    setOpenRouterKey: unused,
    saveAgentMail: unused,
    provisionAgentMailInbox: unused,
    sendAgentMailTest: unused,
    connect: unused,
    verify: unused,
  };
}

export function SetupView() {
  const [steps, setSteps] = useState<Record<SetupStepId, StepState>>(INITIAL);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [running, setRunning] = useState<SetupStepId[] | "all" | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [finished, setFinished] = useState<{ verified: SetupStepId[]; skipped: SetupStepId[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvedSteps, setApprovedSteps] = useState<Set<SetupStepId>>(() => new Set());
  const promptRef = useRef<Prompt | null>(null);
  const currentStep = useRef<SetupStepId | null>(null);
  const pendingApprovalHighlights = useRef<Set<SetupStepId>>(new Set());
  const approvalHighlightTimers = useRef<Map<SetupStepId, ReturnType<typeof setTimeout>>>(new Map());

  const patch = useCallback((id: SetupStepId, next: Partial<StepState>) => {
    setSteps((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));
  }, []);

  const revealApprovalHighlights = useCallback(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    const ids = [...pendingApprovalHighlights.current];
    if (ids.length === 0) return;
    pendingApprovalHighlights.current.clear();
    setApprovedSteps((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      const existing = approvalHighlightTimers.current.get(id);
      if (existing) clearTimeout(existing);
      approvalHighlightTimers.current.set(id, setTimeout(() => {
        approvalHighlightTimers.current.delete(id);
        setApprovedSteps((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, APPROVAL_HIGHLIGHT_MS));
    }
  }, []);

  const queueApprovalHighlight = useCallback((id: SetupStepId) => {
    pendingApprovalHighlights.current.add(id);
    revealApprovalHighlights();
  }, [revealApprovalHighlights]);

  /**
   * Passive read, so the page shows where you stand before you press anything.
   * The rules for "satisfied" come from the shared module, the same ones the CLI
   * uses to decide whether running the wizard is worth anyone's time.
   */
  const refreshStatus = useCallback(async () => {
    const [state, h] = await Promise.all([
      summarizeSetup(readOnlyBackend()).catch(() => null),
      fetchHealth().catch(() => null),
    ]);
    setHealth(h);
    if (!state) return;
    setSteps(
      state.reduce(
        (acc, s) => ({
          ...acc,
          [s.id]: { status: s.satisfied ? "ready" : s.required ? "failed" : "unknown", detail: s.detail, fix: s.fix },
        }),
        {} as Record<SetupStepId, StepState>,
      ),
    );
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const revealOnReturn = () => revealApprovalHighlights();
    window.addEventListener("focus", revealOnReturn);
    document.addEventListener("visibilitychange", revealOnReturn);
    return () => {
      window.removeEventListener("focus", revealOnReturn);
      document.removeEventListener("visibilitychange", revealOnReturn);
      for (const timer of approvalHighlightTimers.current.values()) clearTimeout(timer);
      approvalHighlightTimers.current.clear();
    };
  }, [revealApprovalHighlights]);

  function askVia(stepId: SetupStepId, question: string, secret: boolean): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const entry: Prompt = { stepId, question, secret, resolve, reject };
      promptRef.current = entry;
      setPromptValue("");
      setPrompt(entry);
    });
  }

  function cancelPrompt() {
    const entry = promptRef.current;
    if (!entry) return;
    promptRef.current = null;
    setPrompt(null);
    setPromptValue("");
    entry.reject(new Error("Cancelled. Nothing was saved; run this step again when you have the key."));
  }

  function answerPrompt() {
    const entry = promptRef.current;
    if (!entry) return;
    promptRef.current = null;
    setPrompt(null);
    entry.resolve(promptValue.trim());
    setPromptValue("");
  }

  async function run(only?: SetupStepId[]) {
    const readyAtRunStart = new Set(
      SETUP_STEPS.filter((step) => steps[step.id].status === "ready").map((step) => step.id),
    );
    setRunning(only ?? "all");
    setError(null);
    setFinished(null);

    const io: SetupIO = {
      canPrompt: () => true, // a form is a prompt anyone can answer
      // The only free-text question the flow asks is the alert address, which
      // belongs to the agentmail step. Reading it off `prompt` state here would
      // be a stale closure for no gain.
      ask: (question) => askVia("agentmail", question, false),
      askSecret: (question) => askVia("agentmail", question, true),
      confirm: async () => true, // the user pressed Run; do not ask again per step
      openUrl: async (url) => {
        try {
          // Opened after a network round-trip rather than straight off the
          // click, so a popup blocker can refuse it. A null handle is that
          // refusal, and the caller renders the link instead.
          const win = window.open(url, "_blank", "noopener,noreferrer");
          return win !== null;
        } catch {
          return false;
        }
      },
      emit: (event: SetupEvent) => renderEvent(event),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    const backend: SetupBackend = {
      openRouterCredits: async () => {
        const credits = await fetchOpenRouterCredits().catch(() => null);
        return credits ? { ok: true, balance: credits.remaining } : { ok: false, error: "No usable OpenRouter key yet." };
      },
      startOpenRouterOAuth: () => startOpenRouterOAuth(),
      setOpenRouterKey: async (key) => {
        await completeOnboarding(key);
      },
      agentMailStatus: async () => {
        const s = await fetchAgentMailSettings();
        return { hasKey: s.hasKey, owner: s.owner, address: s.address, canSend: s.canSend, webhookReady: s.webhookReady };
      },
      saveAgentMail: async (input) => {
        await saveAgentMailSettings({
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.owner ? { owner: input.owner } : {}),
        });
      },
      provisionAgentMailInbox: () => setupAgentMail(),
      sendAgentMailTest: () => sendAgentMailTest(),
      probeMainModel: () => probeMainModel(),
      listConnections: () => fetchConnections(),
      connect: (name) => connectConnection(name) as ReturnType<SetupBackend["connect"]>,
      verify: (name) => verifyConnection(name),
    };

    function renderEvent(event: SetupEvent) {
      switch (event.type) {
        case "step-begin":
          currentStep.current = event.id;
          patch(event.id, { status: "checking", detail: undefined, authUrl: undefined, blocked: false, fix: undefined });
          break;
        case "step-satisfied":
          patch(event.id, { status: "ready", detail: event.detail });
          break;
        case "open-url":
          // Held for whichever step is mid-flight. Losing it for composio meant
          // a blocked popup left the user with nothing to click.
          patch(currentStep.current ?? "openrouter", { authUrl: event.url, blocked: !event.opened });
          break;
        case "waiting":
          patch(event.id, { status: "waiting", detail: event.detail });
          break;
        case "verifying":
          patch(event.id, { status: "checking", detail: event.detail });
          break;
        case "verified":
          patch(event.id, { status: "ready", detail: event.summary });
          // Existing ready steps also emit `verified` during a re-check. Only a
          // newly satisfied step is something the user just added. If OAuth is
          // finishing in another tab, hold the confirmation until this page
          // has focus again so the green fade is actually seen.
          if (!readyAtRunStart.has(event.id)) queueApprovalHighlight(event.id);
          break;
        case "step-failed":
          patch(event.id, { status: "failed", detail: event.message, fix: event.fix });
          // Also held at page level: the status refresh that runs when the flow
          // ends rewrites every card from the server's view, which would erase
          // the one thing explaining what just went wrong.
          setError(`${event.id}: ${event.message}`);
          break;
        case "step-skipped":
          patch(event.id, { status: "skipped", detail: event.reason });
          break;
        case "complete":
          setFinished({ verified: event.verified, skipped: event.skipped });
          break;
        case "error":
          setError(event.message);
          break;
        default:
          break;
      }
    }

    try {
      await runSetupFlow(io, backend, { dashboardUrl: window.location.origin, ...(only ? { only } : {}) });
      await completeOnboarding();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      promptRef.current = null;
      setPrompt(null);
      setRunning(null);
      await refreshStatus();
      await mutate("connections");
    }
  }

  const readyCount = SETUP_STEPS.filter((s) => steps[s.id].status === "ready").length;
  const requiredBlocked = SETUP_STEPS.filter((s) => s.required && steps[s.id].status !== "ready");

  return (
    <div className="pane-glow flex h-full flex-col overflow-y-auto">
      <PaneHeader
        title="Setup"
        badge={`${readyCount} of ${SETUP_STEPS.length} ready`}
        actions={
          <Button variant="accent" size="sm" onClick={() => void run()} disabled={running !== null}>
            {running ? "Running…" : requiredBlocked.length ? "Run setup" : "Re-check everything"}
          </Button>
        }
      />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-5">
        {requiredBlocked.length > 0 && running === null ? (
          <Notice tone="warning" title="Jig is not fully wired up yet">
            {requiredBlocked.map((s) => s.title).join(" and ")} still {requiredBlocked.length === 1 ? "needs" : "need"} attention.
            Fix one below, or run everything from the top. Each step opens what it needs in a new tab.
          </Notice>
        ) : null}

        {error ? <Notice tone="danger" title="Setup stopped">{error}</Notice> : null}

        {/* The old "Setup complete: verified composio" notice sat above three
            green cards saying the same thing, and named only the step that had
            just run, which read as though the others had not. The cards below
            are the status; a run only needs to report what it could not do. */}
        {finished && !error && finished.skipped.length > 0 ? (
          <Notice tone="neutral" title="Some steps were skipped">
            {finished.skipped.join(", ")}. Everything else is shown below.
          </Notice>
        ) : null}

        {requiredBlocked.length === 0 ? <FirstJig /> : null}

        <Section label={requiredBlocked.length ? "What Jig needs" : "Connected"}>
          {SETUP_STEPS.map((step) => {
            const state = steps[step.id];
            const asking = prompt?.stepId === step.id;
            const done = state.status === "ready" && !asking;
            return (
              <section
                key={step.id}
                // A finished step is reference, not work: it collapses to one
                // line and drops the explanation, because nobody needs to be
                // told what OpenRouter is for once it is connected. Anything
                // still outstanding keeps the full card and the blurb.
                className={`rounded-xl border transition-colors ${approvedSteps.has(step.id) ? "setup-step-approved" : ""} ${done ? "px-4 py-2.5" : "p-4"} ${
                  done ? "border-[#1f1f23] bg-[#0b0b0d]" : "border-[#1f1f23] bg-[#0d0d0f]"
                }`}
              >
                {/* Icons line up with the title. Centring them drifts to the
                    middle of a three-line card and reads as misaligned. */}
                <div className={`flex gap-3 ${done ? "items-center" : "items-start"}`}>
                  <span className={done ? "" : "mt-0.5 shrink-0"}>
                    <ServiceIcon name={step.id} size={done ? 15 : 18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      {/* The name identifies the row, so the DETAIL gives way
                          when space runs out, never the title. */}
                      <h3
                        className={`font-medium text-[#ededed] ${done ? "shrink-0 whitespace-nowrap text-[13px]" : "truncate text-[14px]"}`}
                      >
                        {step.title}
                      </h3>
                      {!step.required && !done ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)]">optional</span>
                      ) : null}
                      {done && state.detail ? (
                        <span className="min-w-0 truncate text-[12px] text-[var(--text-dim)]" title={state.detail}>
                          {state.detail}
                        </span>
                      ) : null}
                    </div>
                    {!done ? (
                      <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-dim)]">{STEP_BLURB[step.id]}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {done ? (
                      <span className="text-[13px] text-emerald-400" title="ready" aria-label="ready">
                        ✓
                      </span>
                    ) : (
                      statusPill(state)
                    )}
                    <Button
                      size="sm"
                      // Filled when there is something to do, so the action reads
                      // as a button rather than as a second status chip sitting
                      // next to the first one.
                      variant={state.status === "ready" ? "subtle" : "success"}
                      onClick={() => void run([step.id])}
                      disabled={running !== null}
                    >
                      {running !== "all" && Array.isArray(running) && running[0] === step.id
                        ? "Working…"
                        : state.status === "ready"
                          ? "Re-check"
                          : step.id === "openrouter"
                            ? "Authorize"
                            : step.id === "composio"
                              ? "Connect"
                              : "Set up"}
                    </Button>
                  </div>
                </div>

                {state.detail && !done ? (
                  <p className="mt-3 flex items-center gap-2 pl-[30px] text-[12px] text-[var(--text-dim)]">
                    {state.status === "checking" || state.status === "waiting" ? <Spinner size={12} /> : null}
                    {state.status === "checking" || state.status === "waiting" ? (
                      <ShimmerText>{state.detail}</ShimmerText>
                    ) : (
                      state.detail
                    )}
                  </p>
                ) : null}

                {state.fix && state.status === "failed" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-[30px]">
                    {state.fix.url ? (
                      <a className={buttonClasses({ variant: "success", size: "sm" })} href={state.fix.url} target="_blank" rel="noreferrer">
                        {state.fix.label} ↗
                      </a>
                    ) : null}
                    {state.fix.settings === "models" ? (
                      <a className={buttonClasses({ variant: "subtle", size: "sm" })} href="/?view=settings&tab=models">
                        Change main model
                      </a>
                    ) : null}
                  </div>
                ) : null}

                {state.authUrl && (state.status === "waiting" || state.status === "checking") ? (
                  <a
                    className={`mt-2 inline-block pl-[30px] text-[12px] underline ${
                      state.blocked ? "font-medium text-amber-300" : "text-emerald-400"
                    }`}
                    href={state.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {state.blocked
                      ? "Your browser blocked the popup. Open the authorization here."
                      : "Authorization did not open? Use this link."}
                  </a>
                ) : null}

                {asking ? (
                  <form
                    // Keyed on the question so a new one remounts the field:
                    // otherwise the box silently swaps its meaning under the
                    // user, and autoFocus does not re-fire on the same element.
                    key={prompt.question}
                    className="mt-3 pl-[30px]"
                    onSubmit={(e) => {
                      e.preventDefault();
                      answerPrompt();
                    }}
                  >
                    <label className="mb-1.5 block text-[12px] text-[#ededed]">{prompt.question}</label>
                    {prompt.secret ? null : (
                      <p className="mb-1.5 text-[11px] text-[var(--text-faint)]">
                        Saved the key. One more thing before alerts work.
                      </p>
                    )}
                    <div className="flex gap-2">
                    <TextInput
                      autoFocus
                      // A key is not a password: see secretFieldProps.
                      {...(prompt.secret ? secretFieldProps : { type: "text" as const })}
                      placeholder={prompt.secret ? "am_..." : "you@example.com"}
                      value={promptValue}
                      onChange={(e) => setPromptValue(e.target.value)}
                      className="flex-1"
                    />
                    <Button type="submit" variant="success" size="sm" disabled={!promptValue.trim()}>
                      Save
                    </Button>
                    <Button type="button" size="sm" onClick={cancelPrompt}>
                      Cancel
                    </Button>
                    </div>
                  </form>
                ) : null}
              </section>
            );
          })}
        </Section>

        <Section label="This instance">
          <InstancePanel health={health} />
        </Section>

        <Section label="Your machine">
          <CliPairing />
        </Section>
      </div>
    </div>
  );
}

/** A titled group. Three flat stacks of cards read as one undifferentiated list. */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--text-faint)]">{label}</h2>
      {children}
    </section>
  );
}

/**
 * The last thing this page should do is get out of the way and hand over a
 * first thing to try. "Ready" here means three green ticks, which proves the
 * pieces answer, not that they work together: a jig that emails you exercises
 * the model, the mailbox and the runner in one go, and the proof arrives in
 * your inbox rather than as another status pill.
 */
const FIRST_JIG_PROMPT = "create a jig that sends me hello world via email";

function FirstJig() {
  const [copied, setCopied] = useState(false);

  return (
    <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] p-5 shadow-[0_0_0_1px_rgba(16,185,129,0.04)]">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-300/80">Ready</span>
      <h3 className="mt-1.5 text-[17px] font-semibold tracking-[-0.01em] text-[#ededed]">Everything is connected. Try it.</h3>
      <p className="mt-1.5 max-w-[62ch] text-[12px] leading-relaxed text-[var(--text-dim)]">
        Paste this into Jig and approve the jig it writes. It runs a model call, sends real mail through your inbox,
        and lands in your inbox as proof the whole path works.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 truncate rounded-md border border-[#1f1f23] bg-[#111113] px-3 py-2 font-mono text-[11px] text-[#ededed]">
          {FIRST_JIG_PROMPT}
        </code>
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(FIRST_JIG_PROMPT).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <a
          href="/"
          className="inline-flex items-center whitespace-nowrap rounded-md border border-emerald-500/40 bg-[var(--accent-primary-strong)] px-2 py-1 text-[11px] font-medium text-white transition hover:bg-[var(--accent-primary)]"
        >
          Open Jigs
        </a>
      </div>
    </section>
  );
}

/**
 * Connect the CLI without the password.
 *
 * The command a user needed here used to be `jig unlock`, which prompts for the
 * instance password: fine in your own terminal, impossible to hand to a coding
 * agent. A pairing code is single use and expires in ten minutes, so the whole
 * line is safe to paste into a chat.
 */
function CliPairing() {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paired, setPaired] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The CLI redeems the code out of band, so the only way this page learns it
  // worked is to ask. Poll only while a code is outstanding.
  useEffect(() => {
    if (!code || paired) return;
    const timer = setInterval(async () => {
      const status = await fetchPairingStatus().catch(() => null);
      if (status?.claimed) {
        setPaired(true);
        clearInterval(timer);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [code, paired]);

  // `bunx github:` rather than `bun run jig`, because this line gets pasted into
  // a terminal or an agent whose working directory we do not control. `bun run
  // jig` needs the clone, and one directory above it matches the `jig` FOLDER
  // instead of the script and exits silently. This form needs no clone at all.
  const command = code
    ? `bunx --bun github:agamm/jig pair ${code} --url=${typeof window === "undefined" ? "" : window.location.origin}`
    : "";

  const generate = async () => {
    setBusy(true);
    setErr(null);
    setCopied(false);
    setPaired(false);
    try {
      const res = await createPairingCode();
      setCode(res.code);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`rounded-xl border p-4 transition-colors ${
        paired ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-[#1f1f23] bg-[#0d0d0f]"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium text-[#ededed]">Connect the CLI</h3>
          <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-[var(--text-dim)]">
            Lets <code className="text-[#ededed]">jig</code> on your machine talk to this instance. Single-use code,
            good for 10 minutes, so it is safe to paste to a coding agent. Runs from any directory, no checkout needed.
          </p>
        </div>
        <Button size="sm" variant={code ? "subtle" : "success"} onClick={() => void generate()} disabled={busy}>
          {busy ? "Working…" : code ? "New code" : "Generate command"}
        </Button>
      </div>

      {paired ? (
        <p className="mt-3 flex items-center gap-2 text-[12px] text-emerald-300">
          <span aria-hidden>✓</span> CLI connected. That code is spent; generate a new one for another machine.
        </p>
      ) : null}

      {code && !paired ? (
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border border-[#1f1f23] bg-[#111113] px-3 py-2 font-mono text-[11px] text-[#ededed]">
            {command}
          </code>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(command).then(
                () => setCopied(true),
                () => setErr("Could not write to the clipboard. Select the text and copy it."),
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}

      {err ? <p className="mt-2 text-[12px] text-rose-300">{err}</p> : null}
    </section>
  );
}

/**
 * Where this instance is running and whether it will survive a restart. On
 * Railway that second question is the whole ball game: without a mounted
 * volume, `/data` is ephemeral and every credential on this page is gone at the
 * next deploy.
 */
function InstancePanel({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return (
      <div className="rounded-xl border border-[#1f1f23] bg-[#0d0d0f] p-4">
        <div className="flex items-center gap-2">
          <Spinner size={12} />
          <ShimmerText className="text-[12px]">Reading instance health…</ShimmerText>
        </div>
      </div>
    );
  }

  const hosted = health.mode === "service";
  const storage = health.data_storage;
  const rows: { label: string; value: string }[] = [
    { label: "Where", value: hosted ? "Hosted (Railway)" : "Local" },
    { label: "Version", value: health.version },
    ...(health.public_url ? [{ label: "URL", value: health.public_url }] : []),
    ...(storage ? [{ label: "Data", value: `${storage.path}${storage.persistent ? " (persistent)" : " (NOT persistent)"}` }] : []),
    ...(health.scheduler ? [{ label: "Scheduler", value: health.scheduler.running ? "running" : "stopped" }] : []),
  ];

  return (
    <div className="rounded-xl border border-[#1f1f23] bg-[#0b0b0d] px-4 py-3">
      <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[12px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <span className="text-[var(--text-faint)]">{row.label}</span>
            <span className="truncate font-mono text-[#ededed]" title={row.value}>{row.value}</span>
          </div>
        ))}
      </div>

      {hosted && storage && !storage.persistent ? (
        <div className="mt-3">
          <Notice tone="danger" title="No persistent volume">
            {storage.message ?? `${storage.path} is not on a mounted volume.`} Everything set up on this page is lost on the next
            deploy.{storage.action ? ` ${storage.action}` : ""}
          </Notice>
        </div>
      ) : null}
    </div>
  );
}
