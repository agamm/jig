"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { TextInput } from "@/components/input";
import { LoadingState, Notice } from "@/components/state-panel";
import { fetchResendSettings, saveResendSettings, sendResendTest } from "@/lib/api";

/**
 * Resend is the out-of-band system-notification channel. Unlike the MCP
 * notification tools, it doesn't depend on any connection — so it's the only
 * channel that still reaches you when the thing that broke is a connection.
 */
export function ResendSettings({ compact = false }: { compact?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [status, setStatus] = useState<{ tone: "success" | "danger" | "neutral"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchResendSettings()
      .then((data) => {
        if (cancelled) return;
        setHasKey(data.hasKey);
        setConfigured(data.configured);
        setTo(data.to ?? "");
        setFrom(data.from ?? "");
      })
      .catch((e) => setStatus({ tone: "danger", message: `Failed to load: ${e?.message ?? String(e)}` }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      // Only send apiKey when the user typed a new one — leaving it blank
      // keeps the stored key untouched.
      const data = await saveResendSettings({
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        to: to.trim(),
        from: from.trim(),
      });
      setHasKey(data.hasKey);
      setConfigured(data.configured);
      setApiKey("");
      setStatus({ tone: "success", message: "Saved." });
    } catch (e) {
      setStatus({ tone: "danger", message: `Save failed: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setStatus(null);
    try {
      const result = await sendResendTest();
      if (result.ok) setStatus({ tone: "success", message: "Test email sent. Check your inbox." });
      else setStatus({ tone: "danger", message: `Test failed: ${result.error ?? "unknown error"}` });
    } catch (e) {
      setStatus({ tone: "danger", message: `Test failed: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <LoadingState message="Loading Resend settings…" />;

  const canSave = (apiKey.trim().length > 0 || hasKey) && to.trim().length > 0;

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="space-y-1">
          <h4 className="text-[13px] font-medium text-[#ededed]">System alerts (Resend)</h4>
          <p className="text-[11px] leading-relaxed text-[#666]">
            Email alerts about the engine itself — a broken connection, an expired token, a stuck scheduler.
            Delivered directly via Resend, so they arrive even when your MCP connections are down. Get a free
            API key at{" "}
            <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
              resend.com
            </a>
            .
          </p>
        </div>
      )}

      {!configured && (
        <Notice tone="danger" title="No out-of-band alerting">
          If an integration breaks while you&apos;re away, nothing will reach you. Add a Resend API key and a
          recipient email to get notified.
        </Notice>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            Resend API key
          </span>
          <TextInput
            type="password"
            value={apiKey}
            placeholder={hasKey ? "•••••••••• (stored — leave blank to keep)" : "re_..."}
            inputClassName="ui-input-compact"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            Send alerts to
          </span>
          <TextInput
            type="email"
            value={to}
            placeholder="you@example.com"
            inputClassName="ui-input-compact"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            From address (optional)
          </span>
          <TextInput
            type="text"
            value={from}
            placeholder="Jig <onboarding@resend.dev>"
            inputClassName="ui-input-compact"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="block text-[10px] leading-relaxed text-[#555]">
            Defaults to Resend&apos;s shared sender, which only delivers to your own account email. Use a
            verified-domain address to send anywhere.
          </span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={saving || !canSave} variant="success" size="md">
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onTest} disabled={testing || !configured} variant="subtle" size="md">
          {testing ? "Sending…" : "Send test"}
        </Button>
      </div>

      {status && <Notice tone={status.tone}>{status.message}</Notice>}
    </div>
  );
}
