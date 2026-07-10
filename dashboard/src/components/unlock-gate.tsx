"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { completeOnboarding, fetchHealth, setupPassword, unlock } from "@/lib/api";
import type { DataStorageHealth, HealthResponse } from "@shared/api";

/**
 * Blocks the dashboard until the server reports a usable state.
 *
 * Three possible gates shown in sequence, each appearing only when needed:
 *   1. Set-password form — if no password has been set yet.
 *   2. Unlock form — if a password exists but the in-memory key is gone.
 *   3. Onboarding — if unlocked but onboarding has not been marked complete.
 *      Currently one step: add the OpenRouter API key (or skip).
 *
 * In local mode the server reports mode: "local" and we skip the gate.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHealth(await fetchHealth());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Failed to reach server");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <Frame>
        <h1>Can't reach jig</h1>
        <p>The server didn't respond to /api/health. Check the logs and retry.</p>
        <p className="text-[#777]">{error}</p>
      </Frame>
    );
  }
  if (!health) {
    return (
      <Frame>
        <p>Connecting to jig…</p>
      </Frame>
    );
  }

  if (health.mode === "local") return <>{children}</>;
  if (health.data_storage && !health.data_storage.ok) {
    return (
      <Frame>
        <StorageProblem storage={health.data_storage} />
      </Frame>
    );
  }
  if (!health.password_set)
    return <PasswordForm mode="set" setupCodeRequired={!!health.setup_code_required} onDone={refresh} />;
  if (health.locked) return <PasswordForm mode="unlock" onDone={refresh} />;
  if (!health.onboarding_complete) return <OnboardingForm onDone={refresh} />;
  return <>{children}</>;
}

function StorageProblem({ storage }: { storage: DataStorageHealth }) {
  return (
    <>
      <h1>Connect persistent storage</h1>
      <p>
        Jig is running in service mode, but <code className="text-[#ededed]">{storage.path}</code>{" "}
        is not backed by a persistent volume. Passwords, jigs, and connection tokens would be lost on redeploy.
      </p>
      {storage.message && <p className="mt-3 text-[#fb7185]">{storage.message}</p>}
      <p className="mt-4 text-[#aaa]">Run this from the Jig checkout, then reload this page:</p>
      <pre className="mt-2 overflow-x-auto rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 font-mono text-[12px] text-rose-100">
        {storage.action}
      </pre>
    </>
  );
}

function PasswordForm({
  mode,
  setupCodeRequired = false,
  onDone,
}: {
  mode: "set" | "unlock";
  setupCodeRequired?: boolean;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isSet = mode === "set";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (isSet) {
      if (setupCodeRequired && !setupCode.trim()) return setErr("Enter the setup code from your server logs.");
      if (password.length < 8) return setErr("Password must be at least 8 characters.");
      if (password !== confirm) return setErr("Passwords don't match.");
    }
    setBusy(true);
    try {
      if (isSet) await setupPassword(password, setupCodeRequired ? setupCode.trim() : undefined);
      else await unlock(password);
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1>{isSet ? "Welcome to jig" : "Jig is locked"}</h1>
      <p>
        {isSet
          ? "Set a password to encrypt your credentials. It's never stored on disk — you'll re-enter it after any service restart."
          : "Enter your password to unlock the dashboard and resume scheduled jigs."}
      </p>
      {isSet && setupCodeRequired && (
        <p className="mt-2 text-[13px] text-[#aaa]">
          This instance is unclaimed. Paste the one-time{" "}
          <span className="text-[#ededed]">setup code</span> printed in your server logs to claim it.
        </p>
      )}
      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        {isSet && setupCodeRequired && (
          <input
            type="text"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="Setup code (e.g. ABCD-EFGH-JKMN)"
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 font-mono text-[13px] tracking-wide text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
          />
        )}
        <input
          type="password"
          autoFocus={!(isSet && setupCodeRequired)}
          autoComplete={isSet ? "new-password" : "current-password"}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 text-[14px] text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
        />
        {isSet && (
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 text-[14px] text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
          />
        )}
        {err && <p className="text-[13px] text-[#fb7185]">{err}</p>}
        <button
          type="submit"
          disabled={busy || !password || (isSet && setupCodeRequired && !setupCode.trim())}
          className="mt-1 rounded-md bg-emerald-500 px-3 py-2 text-[14px] font-semibold text-white transition disabled:opacity-40"
        >
          {busy ? "Working…" : isSet ? "Set password" : "Unlock"}
        </button>
      </form>
    </Frame>
  );
}

function OnboardingForm({ onDone }: { onDone: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const complete = async (withKey: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await completeOnboarding(withKey ? apiKey.trim() : undefined);
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1>Add your OpenRouter key</h1>
      <p>
        Jigs that call <code className="text-[#ededed]">llm()</code> or{" "}
        <code className="text-[#ededed]">agent()</code> need an OpenRouter API
        key. Grab one from{" "}
        <a
          className="text-emerald-400 underline"
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
        >
          openrouter.ai/keys
        </a>
        . You can always add or change it later in Settings.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void complete(true);
        }}
        className="mt-5 flex flex-col gap-3"
      >
        <input
          type="password"
          autoFocus
          placeholder="sk-or-v1-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 font-mono text-[13px] text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
        />
        {err && <p className="text-[13px] text-[#fb7185]">{err}</p>}
        <div className="mt-1 flex gap-2">
          <button
            type="submit"
            disabled={busy || !apiKey.trim()}
            className="rounded-md bg-emerald-500 px-3 py-2 text-[14px] font-semibold text-white transition disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save key"}
          </button>
          <button
            type="button"
            onClick={() => void complete(false)}
            disabled={busy}
            className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 text-[14px] text-[#aaa] transition hover:text-[#ededed]"
          >
            Skip for now
          </button>
        </div>
      </form>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main
      className="flex h-full items-center justify-center px-4"
      style={{
        background:
          "radial-gradient(circle at top, rgba(255,255,255,0.04), transparent 32rem), linear-gradient(180deg, #0d0d0f 0%, #0a0a0b 100%)",
      }}
    >
      <section className="w-full max-w-md rounded-2xl border border-[#1f1f23] bg-[#111113] p-7 text-[#ededed] shadow-[0_24px_64px_rgba(0,0,0,0.45)]">
        {children}
      </section>
    </main>
  );
}
