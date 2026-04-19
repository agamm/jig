"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

type HealthResponse = {
  mode: "service" | "local";
  locked: boolean;
  password_set: boolean;
};

/**
 * Blocks the dashboard until the server reports unlocked. In local mode
 * the server returns `mode: "local"` and we skip the gate entirely.
 */
export function UnlockGate({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      const data = (await res.json()) as HealthResponse;
      setHealth(data);
      setHealthError(null);
    } catch (e: any) {
      setHealthError(e?.message ?? "Failed to reach server");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (healthError) {
    return (
      <Frame>
        <h1>Can't reach jig</h1>
        <p>The server didn't respond to /api/health. Check logs and try again.</p>
        <p className="text-[#777]">{healthError}</p>
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

  if (health.mode === "local" || !health.locked) {
    return <>{children}</>;
  }

  return <UnlockForm passwordSet={health.password_set} onUnlocked={refresh} />;
}

function UnlockForm({ passwordSet, onUnlocked }: { passwordSet: boolean; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSetup = !passwordSet;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (isSetup) {
      if (password.length < 8) return setError("Password must be at least 8 characters.");
      if (password !== confirm) return setError("Passwords don't match.");
    }
    setBusy(true);
    try {
      const url = isSetup ? "/api/setup-password" : "/api/unlock";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Request failed: ${res.status}`);
        return;
      }
      onUnlocked();
    } catch (e: any) {
      setError(e?.message ?? "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h1>{isSetup ? "Welcome to jig" : "Jig is locked"}</h1>
      <p>
        {isSetup
          ? "Set a password to protect your credentials. It's never stored on disk — you'll enter it again after any service restart."
          : "Enter your password to unlock the dashboard and resume scheduled jigs."}
      </p>
      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3">
        <input
          type="password"
          autoFocus
          autoComplete={isSetup ? "new-password" : "current-password"}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 text-[14px] text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
        />
        {isSetup && (
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="rounded-md border border-[#222226] bg-[#111113] px-3 py-2 text-[14px] text-[#ededed] placeholder-[#555] outline-none focus:border-[#3f3f46]"
          />
        )}
        {error && <p className="text-[13px] text-[#fb7185]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="mt-1 rounded-md bg-emerald-500 px-3 py-2 text-[14px] font-semibold text-white transition disabled:opacity-40"
        >
          {busy ? "Working…" : isSetup ? "Set password" : "Unlock"}
        </button>
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
