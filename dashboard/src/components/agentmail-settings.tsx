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
 * AgentMail makes jig-failure emails repliable: a reply goes straight to the
 * jig's authoring agent, which applies the change and ships it. Provisions an
 * `@agentmail.to` inbox + inbound webhook with one click — no DNS setup.
 */
export function AgentMailSettings({ compact = false }: { compact?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [webhookReady, setWebhookReady] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState<{ tone: "success" | "danger" | "neutral"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAgentMailSettings()
      .then((data) => {
        if (cancelled) return;
        setHasKey(data.hasKey);
        setConfigured(data.configured);
        setWebhookReady(data.webhookReady);
        setAddress(data.address);
        setOwner(data.owner ?? "");
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
    setWebhookReady(data.webhookReady);
    setApiKey("");
    return data;
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
        setWebhookReady(true);
        setConfigured(true);
        setStatus({ tone: "success", message: `Inbox ready: ${result.address}` });
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
      if (result.ok) setStatus({ tone: "success", message: "Test email sent. Reply to it to confirm the loop works." });
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
    <div className="space-y-3">
      {!compact && (
        <div className="space-y-1">
          <h4 className="text-[13px] font-medium text-[#ededed]">Reply-to-edit (AgentMail)</h4>
          <p className="text-[11px] leading-relaxed text-[#666]">
            Sends jig-failure emails from a repliable inbox. Reply in plain English — &ldquo;use the #ops channel
            instead&rdquo; — and the jig&apos;s authoring agent applies the change and ships it. Get a free API key at{" "}
            <a href="https://agentmail.to" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">
              agentmail.to
            </a>
. Needs a public URL for the inbound webhook — auto-detected on Railway/Render/Fly, otherwise set <code className="text-[#888]">JIG_PUBLIC_URL</code>.
          </p>
        </div>
      )}

      {address && (
        <Notice tone={configured ? "success" : "neutral"} title={configured ? "Active" : "Inbox provisioned"}>
          Failure emails come from <span className="font-medium text-[#ededed]">{address}</span>
          {configured ? " — reply to any of them to edit the jig." : " — finish setup to enable replies."}
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
          {connecting ? "Connecting…" : webhookReady ? "Reconnect inbox" : "Connect inbox"}
        </Button>
        <Button onClick={onTest} disabled={testing || !configured} variant="subtle" size="md">
          {testing ? "Sending…" : "Send test"}
        </Button>
      </div>

      {status && <Notice tone={status.tone}>{status.message}</Notice>}
    </div>
  );
}
