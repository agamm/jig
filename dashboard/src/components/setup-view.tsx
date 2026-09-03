"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mutate } from "swr";
import { Button } from "@/components/button";
import { TextInput } from "@/components/input";
import { PaneHeader } from "@/components/pane-header";
import { ServiceIcon } from "@/components/service-icon";
import { ShimmerText } from "@/components/shimmer-text";
import { Spinner } from "@/components/spinner";
import { Notice } from "@/components/state-panel";
import {
  completeOnboarding,
  createPairingCode,
  connectConnection,
  fetchAgentMailSettings,
  fetchConnections,
  fetchHealth,
  fetchOpenRouterCredits,
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
  type SetupBackend,
  type SetupEvent,
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

export function SetupView() {
  const [steps, setSteps] = useState<Record<SetupStepId, StepState>>(INITIAL);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [running, setRunning] = useState<SetupStepId[] | "all" | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [finished, setFinished] = useState<{ verified: SetupStepId[]; skipped: SetupStepId[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const promptRef = useRef<Prompt | null>(null);

  const patch = useCallback((id: SetupStepId, next: Partial<StepState>) => {
    setSteps((prev) => ({ ...prev, [id]: { ...prev[id], ...next } }));
  }, []);

  /** Passive read, so the page shows where you stand before you press anything. */
  const refreshStatus = useCallback(async () => {
    const [credits, mail, connections, h] = await Promise.all([
      fetchOpenRouterCredits().catch(() => null),
      fetchAgentMailSettings().catch(() => null),
      fetchConnections().catch(() => []),
      fetchHealth().catch(() => null),
    ]);
    setHealth(h);
    setSteps({
      openrouter: credits
        ? { status: "ready", detail: `balance $${credits.remaining.toFixed(2)}` }
        : { status: "failed", detail: "No usable key yet." },
      agentmail: mail?.canSend
        ? { status: "ready", detail: `alerts go to ${mail.owner} from ${mail.address}` }
        : { status: "failed", detail: mail?.hasKey ? "Key saved, inbox not provisioned yet." : "No AgentMail key yet." },
      composio: connections.find((c) => c.name === "composio")?.connected
        ? { status: "ready", detail: "connected" }
        : { status: "unknown", detail: "Not connected. Optional, but it is the one that unlocks most apps." },
    });
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

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
          window.open(url, "_blank", "noopener,noreferrer");
          return true;
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
      listConnections: () => fetchConnections(),
      connect: (name) => connectConnection(name) as ReturnType<SetupBackend["connect"]>,
      verify: (name) => verifyConnection(name),
    };

    function renderEvent(event: SetupEvent) {
      switch (event.type) {
        case "step-begin":
          patch(event.id, { status: "checking", detail: undefined, authUrl: undefined });
          break;
        case "step-satisfied":
          patch(event.id, { status: "ready", detail: event.detail });
          break;
        case "open-url":
          if (event.purpose.includes("OpenRouter")) patch("openrouter", { authUrl: event.url });
          break;
        case "waiting":
          patch(event.id, { status: "waiting", detail: event.detail });
          break;
        case "verifying":
          patch(event.id, { status: "checking", detail: event.detail });
          break;
        case "verified":
          patch(event.id, { status: "ready", detail: event.summary });
          break;
        case "step-failed":
          patch(event.id, { status: "failed", detail: event.message });
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
    <div className="flex h-full flex-col overflow-y-auto">
      <PaneHeader
        title="Setup"
        badge={`${readyCount} of ${SETUP_STEPS.length} ready`}
        actions={
          <Button variant="accent" size="sm" onClick={() => void run()} disabled={running !== null}>
            {running ? "Running…" : requiredBlocked.length ? "Run setup" : "Re-check everything"}
          </Button>
        }
      />

      <div className="flex flex-col gap-4 p-4">
        <InstancePanel health={health} />

        {requiredBlocked.length > 0 && running === null ? (
          <Notice tone="warning" title="Jig is not fully wired up yet">
            {requiredBlocked.map((s) => s.title).join(" and ")} still {requiredBlocked.length === 1 ? "needs" : "need"} attention.
            Fix one below, or run everything from the top. Each step opens what it needs in a new tab.
          </Notice>
        ) : null}

        {error ? <Notice tone="danger" title="Setup stopped">{error}</Notice> : null}

        {finished && !error ? (
          <Notice tone="success" title="Setup complete">
            Verified: {finished.verified.join(", ") || "none"}.
            {finished.skipped.length ? ` Skipped: ${finished.skipped.join(", ")}.` : ""}
          </Notice>
        ) : null}

        <CliPairing />

        <div className="flex flex-col gap-3">
          {SETUP_STEPS.map((step) => {
            const state = steps[step.id];
            const asking = prompt?.stepId === step.id;
            return (
              <section
                key={step.id}
                className={`rounded-xl border p-4 transition-colors ${
                  state.status === "ready" ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-[#1f1f23] bg-[#0d0d0f]"
                }`}
              >
                <div className="flex items-center gap-3">
                  <ServiceIcon name={step.id} size={18} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[14px] font-medium text-[#ededed]">{step.title}</h3>
                      {!step.required ? (
                        <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)]">optional</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-dim)]">{STEP_BLURB[step.id]}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {statusPill(state)}
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

                {state.detail ? (
                  <p className="mt-3 flex items-center gap-2 pl-[30px] text-[12px] text-[var(--text-dim)]">
                    {state.status === "checking" || state.status === "waiting" ? <Spinner size={12} /> : null}
                    {state.status === "checking" || state.status === "waiting" ? (
                      <ShimmerText>{state.detail}</ShimmerText>
                    ) : (
                      state.detail
                    )}
                  </p>
                ) : null}

                {state.authUrl && state.status === "waiting" ? (
                  <a
                    className="mt-2 inline-block pl-[30px] text-[12px] text-emerald-400 underline"
                    href={state.authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Authorization did not open? Use this link.
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
                      type={prompt.secret ? "password" : "text"}
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
        </div>
      </div>
    </div>
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
  const [err, setErr] = useState<string | null>(null);

  const command = code ? `bun run jig pair ${code} --url=${typeof window === "undefined" ? "" : window.location.origin}` : "";

  const generate = async () => {
    setBusy(true);
    setErr(null);
    setCopied(false);
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
    <section className="rounded-xl border border-[#1f1f23] bg-[#0d0d0f] p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium text-[#ededed]">Connect the CLI</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-dim)]">
            Lets <code className="text-[#ededed]">jig</code> on your machine talk to this instance. Single-use code,
            good for 10 minutes, so the command is safe to paste to a coding agent.
          </p>
        </div>
        <Button size="sm" variant={code ? "subtle" : "success"} onClick={() => void generate()} disabled={busy}>
          {busy ? "Working…" : code ? "New code" : "Generate command"}
        </Button>
      </div>

      {code ? (
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
    <div className="rounded-xl border border-[#1f1f23] bg-[#0d0d0f] p-4">
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
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
