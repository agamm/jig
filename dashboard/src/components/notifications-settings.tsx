"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { fetchNotificationSettings, resetLocalState, saveNotificationSettings, sendTestNotification } from "@/lib/api";
import type {
  NotificationCapableTool,
  NotificationChannel,
  NotificationSettings,
} from "@shared/api";

type ChannelDraft = {
  enabled: boolean;
  recipient: string;
  extra: Record<string, string>;
};

const DEFAULT_DRAFT: ChannelDraft = { enabled: false, recipient: "", extra: {} };

function channelKey(connection: string, tool: string): string {
  return `${connection}:${tool}`;
}

function statusTone(status: string | null): "error" | "success" | "neutral" {
  if (!status) return "neutral";
  if (status.startsWith("Failed") || status.startsWith("Save failed") || status.startsWith("Test failed") || status.startsWith("Reset failed")) {
    return "error";
  }
  if (status === "Saved." || status.startsWith("Test sent") || status.startsWith("Sent:")) {
    return "success";
  }
  return "neutral";
}

export function NotificationsSettings({ onReset }: { onReset?: () => Promise<void> | void } = {}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [tools, setTools] = useState<NotificationCapableTool[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ChannelDraft>>({});
  const [triggerOnFail, setTriggerOnFail] = useState(true);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNotificationSettings()
      .then((data) => {
        if (cancelled) return;
        setTools(data.availableTools);
        const next: Record<string, ChannelDraft> = {};
        for (const t of data.availableTools) {
          const key = channelKey(t.connection, t.tool);
          const saved = data.settings.channels.find(
            (c) => c.connection === t.connection && c.tool === t.tool,
          );
          next[key] = saved
            ? {
                enabled: true,
                recipient: saved.recipient,
                extra: Object.fromEntries(
                  t.extraRequired.map((k) => [k, String(saved.extraParams?.[k] ?? "")]),
                ),
              }
            : { ...DEFAULT_DRAFT, extra: Object.fromEntries(t.extraRequired.map((k) => [k, ""])) };
        }
        setDrafts(next);
        setTriggerOnFail(data.settings.triggerOn?.fail ?? true);
      })
      .catch((e) => setStatus(`Failed to load: ${e?.message ?? String(e)}`))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function buildSettings(): NotificationSettings {
    const channels: NotificationChannel[] = [];
    for (const t of tools) {
      const key = channelKey(t.connection, t.tool);
      const draft = drafts[key];
      if (!draft?.enabled || !draft.recipient.trim()) continue;
      channels.push({
        connection: t.connection,
        tool: t.tool,
        recipient: draft.recipient.trim(),
        ...(t.extraRequired.length > 0 && {
          extraParams: Object.fromEntries(
            t.extraRequired.map((k) => [k, draft.extra[k] ?? ""]),
          ),
        }),
      });
    }
    return { channels, triggerOn: { fail: triggerOnFail } };
  }

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      await saveNotificationSettings(buildSettings());
      setStatus("Saved.");
    } catch (e: unknown) {
      setStatus(`Save failed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setStatus(null);
    try {
      // Save first so the test reflects the current draft
      await saveNotificationSettings(buildSettings());
      const report = await sendTestNotification();
      const okCount = report.sent.length;
      const errCount = report.errors.length;
      if (errCount === 0) setStatus(`Test sent to ${okCount} channel${okCount === 1 ? "" : "s"}.`);
      else setStatus(`Sent: ${okCount}, errors: ${report.errors.map((e) => `${e.channel} (${e.error})`).join("; ")}`);
    } catch (e: unknown) {
      setStatus(`Test failed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  function updateDraft(key: string, patch: Partial<ChannelDraft>) {
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function onResetConfirm() {
    setResetting(true);
    setStatus(null);
    try {
      const result = await resetLocalState();
      setConfirmResetOpen(false);
      const deletedJigs = Array.isArray(result.deletedJigs) ? result.deletedJigs : [];
      const disconnectedConnections = Array.isArray(result.disconnectedConnections) ? result.disconnectedConnections : [];
      const disconnected = disconnectedConnections.length;
      setStatus(
        disconnected > 0
          ? `Reset complete. Removed ${deletedJigs.length} jig${deletedJigs.length === 1 ? "" : "s"} and disconnected ${disconnected} connection${disconnected === 1 ? "" : "s"}.`
          : `Reset complete. Removed ${deletedJigs.length} jig${deletedJigs.length === 1 ? "" : "s"}.`
      );
      await onReset?.();
    } catch (e: unknown) {
      setStatus(`Reset failed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return <p className="text-[12px] text-[#555]">Loading…</p>;
  }

  const tone = statusTone(status);
  const hasEditableChannels = tools.length > 0;

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={confirmResetOpen}
        title="Start from scratch?"
        message="This will delete all local jig files, clear the local SQLite database, and disconnect saved connections on this machine. Example jigs in examples/ are kept. The app will return to onboarding."
        confirmLabel="Delete Everything"
        destructive
        loading={resetting}
        onConfirm={onResetConfirm}
        onClose={() => !resetting && setConfirmResetOpen(false)}
      />

      <div className="rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-4">
        <div className="space-y-1">
          <h4 className="text-[13px] font-medium text-[#ededed]">Notifications</h4>
          <p className="text-[11px] leading-relaxed text-[#666]">
            Configure failure alerts and test delivery. Available channels come from connected tools classified as notification-capable.
          </p>
        </div>

        {tools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#242428] bg-[#0d0d0f] px-4 py-6 text-center">
            <p className="text-[12px] text-[#6b6b72]">
              No notification-capable tools detected yet. Run <code className="text-[#9a9aa3]">jig connect</code> to add one.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tools.map((tool) => {
              const key = channelKey(tool.connection, tool.tool);
              const draft = drafts[key] ?? { ...DEFAULT_DRAFT };
              return (
                <div
                  key={key}
                  className="rounded-lg border border-[#1f1f23] bg-[#0d0d0f] px-4 py-3 space-y-2"
                >
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => updateDraft(key, { enabled: e.target.checked })}
                      className="accent-white"
                    />
                    <span className="text-[13px] text-[#ededed]">{tool.label}</span>
                    <span className="rounded-full border border-[#232327] px-1.5 py-0.5 text-[10px] text-[#666]">{tool.connection}</span>
                  </label>
                  {draft.enabled && (
                    <div className="space-y-1.5 pl-6">
                      <input
                        type="text"
                        placeholder={tool.recipientField}
                        value={draft.recipient}
                        onChange={(e) => updateDraft(key, { recipient: e.target.value })}
                        className="w-full bg-[#09090b] border border-[#1f1f23] rounded px-2 py-1.5 text-[12px] text-[#ededed] outline-none focus:border-[#333]"
                      />
                      {tool.extraRequired.map((field) => (
                        <input
                          key={field}
                          type="text"
                          placeholder={field}
                          value={draft.extra[field] ?? ""}
                          onChange={(e) =>
                            updateDraft(key, { extra: { ...draft.extra, [field]: e.target.value } })
                          }
                          className="w-full bg-[#09090b] border border-[#1f1f23] rounded px-2 py-1.5 text-[12px] text-[#ededed] outline-none focus:border-[#333]"
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-[#1f1f23] bg-[#0d0d0f] px-3 py-3">
          <input
            type="checkbox"
            checked={triggerOnFail}
            onChange={(e) => setTriggerOnFail(e.target.checked)}
            className="accent-white"
          />
          <div>
            <span className="block text-[13px] text-[#ededed]">Notify on jig failure</span>
            <span className="block text-[11px] text-[#666]">Send alerts when a jig run finishes with a failure.</span>
          </div>
        </label>
        <div className="flex items-center gap-2">
          <button
            onClick={onSave}
            disabled={saving || !hasEditableChannels}
            className="text-[12px] text-[#ededed] rounded-md border border-[#1f1f23] bg-[#1a1a1d] hover:bg-[#222] px-3 py-1.5 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onTest}
            disabled={testing || !hasEditableChannels}
            className="text-[12px] text-[#888] rounded-md border border-[#1f1f23] hover:text-[#ededed] hover:bg-[#111] px-3 py-1.5 disabled:opacity-50"
          >
            {testing ? "Sending…" : "Send test"}
          </button>
        </div>
        {status && (
          <div
            className={`rounded-lg px-3 py-2 text-[11px] ${
              tone === "error"
                ? "border border-rose-500/20 bg-rose-500/[0.06] text-rose-200"
                : tone === "success"
                  ? "border border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-200"
                  : "border border-[#1f1f23] bg-[#0d0d0f] text-[#888]"
            }`}
          >
            {status}
          </div>
        )}
      </div>

      <div className="space-y-3 pt-2">
        <h4 className="text-[12px] text-rose-300 uppercase tracking-wider">Danger Zone</h4>
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-4 py-4 space-y-3">
          <div>
            <p className="text-[13px] text-rose-100">Start from scratch</p>
            <p className="mt-1 text-[11px] leading-relaxed text-rose-100/60">
              Deletes all local jigs, clears saved connection auth on this machine, and returns the dashboard to onboarding. Example jigs in <code className="text-rose-100/80">examples/</code> are preserved.
            </p>
          </div>
          <button
            onClick={() => setConfirmResetOpen(true)}
            disabled={resetting}
            className="text-[12px] rounded-md border border-rose-500/30 bg-rose-500/[0.08] px-3 py-1.5 text-rose-200 hover:bg-rose-500/[0.14] disabled:opacity-50"
          >
            {resetting ? "Deleting…" : "Delete Local Data"}
          </button>
        </div>
      </div>
    </div>
  );
}
