"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { TextInput } from "@/components/input";
import { LoadingState, Notice } from "@/components/state-panel";
import {
  fetchAgentMailSettings,
  saveAgentMailSettings,
  sendAgentMailTest,
  setupAgentMail,
} from "@/lib/api";

/**
 * AgentMail is the only path failure alerts take: a direct HTTPS send that
 * still works when the connection a jig broke on is the thing that's down. It
 * also makes those emails repliable — a reply goes straight to the jig's
 * authoring agent, which applies the change and ships it. Provisions an
 * `@agentmail.to` inbox + inbound webhook with one click — no DNS setup.
 */
export function AgentMailSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [canSend, setCanSend] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [owner, setOwner] = useState("");
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);
  const [status, setStatus] = useState<{ tone: "success" | "danger" | "neutral"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentMailSettings()
      .then((data) => {
        if (cancelled) return;
        setHasKey(data.hasKey);
        setConfigured(data.configured);
        setCanSend(data.canSend);
        setAddress(data.address);
        setOwner(data.owner ?? "");
        setNotifyOnFailure(data.notifyOnFailure);
      })
      .catch((e) => setStatus({ tone: "danger", message: `Failed to load: ${e?.message ?? String(e)}` }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist a just-entered key/owner so server-side actions (setup, test) read
  // the current values from the credentials/settings store, not stale state.
  async function persist() {
    const data = await saveAgentMailSettings({
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      owner: owner.trim(),
    });
    setHasKey(data.hasKey);
    setConfigured(data.configured);
    setCanSend(data.canSend);
    setNotifyOnFailure(data.notifyOnFailure);
    setApiKey("");
    return data;
  }

  // Saves on click rather than waiting for the Save button: it's one boolean
  // with nothing to validate, and Save is gated on key + email being filled in.
  async function onToggleNotify() {
    const next = !notifyOnFailure;
    setNotifyOnFailure(next);
    setStatus(null);
    try {
      await saveAgentMailSettings({ notifyOnFailure: next });
    } catch (e) {
      setNotifyOnFailure(!next);
      setStatus({ tone: "danger", message: `Save failed: ${(e as Error)?.message ?? String(e)}` });
    }
  }

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      await persist();
      setStatus({ tone: "success", message: "Saved." });
    } catch (e) {
      setStatus({ tone: "danger", message: `Save failed: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function onConnect() {
    setConnecting(true);
    setStatus(null);
    try {
      if (apiKey.trim() || owner.trim()) await persist();
      const result = await setupAgentMail();
      if (result.ok) {
        setAddress(result.address ?? null);
        setCanSend(true);
        setConfigured(!!result.webhookReady);
        setStatus(
          result.webhookReady
            ? { tone: "success", message: `Inbox ready: ${result.address} — alerts + reply-to-edit are live.` }
            : { tone: "neutral", message: `Inbox ready: ${result.address}. Alerts are live; reply-to-edit needs a public URL — set JIG_PUBLIC_URL (or deploy) and reconnect.` },
        );
      } else {
        setStatus({ tone: "danger", message: `Setup failed: ${result.error ?? "unknown error"}` });
      }
    } catch (e) {
      setStatus({ tone: "danger", message: `Setup failed: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setConnecting(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setStatus(null);
    try {
      const result = await sendAgentMailTest();
      if (result.ok) setStatus({ tone: "success", message: "Test email sent. If it's not in your inbox, check Spam/Promotions and mark it “Not spam” so future emails arrive." });
      else setStatus({ tone: "danger", message: `Test failed: ${result.error ?? "unknown error"}` });
    } catch (e) {
      setStatus({ tone: "danger", message: `Test failed: ${(e as Error)?.message ?? String(e)}` });
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <LoadingState message="Loading AgentMail settings…" />;

  const canSave = (apiKey.trim().length > 0 || hasKey) && owner.trim().length > 0;
  const canConnect = canSave;

  return (
    <section className="space-y-3 rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h4 className="text-[13px] font-medium text-[#ededed]">Failure alerts (AgentMail)</h4>
          <p className="text-[11px] leading-relaxed text-[#666]">
            Emails you when a jig fails, over a direct HTTPS send that still works when the connection the jig
            broke on is the thing that&apos;s down. The inbox is repliable: answer in plain English — &ldquo;use the
            #ops channel instead&rdquo; — and the jig&apos;s authoring agent applies the change and ships it. Get a
            free API key at{" "}
            <a href="https://agentmail.to" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
              agentmail.to
            </a>
. Needs a public URL for the inbound webhook — auto-detected on Railway/Render/Fly, otherwise set <code className="text-[#888]">JIG_PUBLIC_URL</code>.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-input)] px-2 py-1">
          <span className="text-[10px] text-[var(--text-dim)]">Notify on failures</span>
          <button
            type="button"
            role="switch"
            aria-checked={notifyOnFailure}
            aria-label="Notify on jig failure"
            onClick={onToggleNotify}
            className={`relative inline-flex h-[18px] w-8 rounded-full border transition-colors duration-150 ${
              notifyOnFailure
                ? "border-emerald-400/35 bg-emerald-500/80"
                : "border-[var(--border-strong)] bg-[var(--surface-muted)]"
            }`}
          >
            <span
              className={`absolute top-[1px] h-[14px] w-[14px] rounded-full bg-white transition-transform duration-150 ${
                notifyOnFailure ? "translate-x-[15px]" : "translate-x-[1px]"
              }`}
            />
          </button>
        </div>
      </div>

      {!canSend && (
        <Notice tone="danger" title="No failure alerting set up">
          If a jig fails or an integration breaks while you&apos;re away, nothing will reach you. Add an AgentMail
          API key and your email, then connect an inbox to start getting alerts.
        </Notice>
      )}

      {canSend && !notifyOnFailure && (
        <Notice tone="warning" title="Failure alerts are paused">
          Jigs can fail without reaching you. The inbox stays connected — jigs can still send email — but nothing
          goes out when a run fails until you turn this back on.
        </Notice>
      )}

      {address && (
        <Notice tone={configured ? "success" : "neutral"} title={configured ? "Active" : "Alerts on"}>
          Failure emails come from <span className="font-medium text-[#ededed]">{address}</span>
          {configured
            ? " — reply to any of them to edit the jig."
            : " — reply-to-edit needs a public URL; set JIG_PUBLIC_URL (or deploy) and reconnect."}
        </Notice>
      )}

      {canSend && address && (
        <Notice tone="warning" title="Check spam on the first email">
          New mail from <span className="font-medium text-[#ededed]">{address}</span> often lands in
          Spam/Promotions at first. Send a test below, find it, and mark it “Not spam” (or add the address to
          your contacts) — after that, alerts and digests land in your inbox.
        </Notice>
      )}

      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            AgentMail API key
          </span>
          <TextInput
            type="password"
            value={apiKey}
            placeholder={hasKey ? "•••••••••• (stored — leave blank to keep)" : "..."}
            inputClassName="ui-input-compact"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            Your email (sender + only allowed replier)
          </span>
          <TextInput
            type="email"
            value={owner}
            placeholder="you@example.com"
            inputClassName="ui-input-compact"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={saving || !canSave} variant="success" size="md">
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button onClick={onConnect} disabled={connecting || !canConnect} variant="accent" size="md">
          {connecting ? "Connecting…" : canSend ? "Reconnect inbox" : "Connect inbox"}
        </Button>
        <Button onClick={onTest} disabled={testing || !canSend} variant="subtle" size="md">
          {testing ? "Sending…" : "Send test"}
        </Button>
      </div>

      {status && <Notice tone={status.tone}>{status.message}</Notice>}
    </section>
  );
}
