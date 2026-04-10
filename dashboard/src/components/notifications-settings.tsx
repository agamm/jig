"use client";

import { useEffect, useState } from "react";
import { fetchNotificationSettings, saveNotificationSettings, sendTestNotification } from "@/lib/api";
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

export function NotificationsSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
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

  if (loading) {
    return <p className="text-[12px] text-[#555]">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {tools.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#1f1f23] px-4 py-6 text-center">
          <p className="text-[12px] text-[#444]">
            No notification-capable tools detected. Run <code className="text-[#777]">jig connect</code> to add one.
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
                className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3 space-y-2"
              >
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => updateDraft(key, { enabled: e.target.checked })}
                    className="accent-white"
                  />
                  <span className="text-[13px] text-[#ededed]">{tool.label}</span>
                  <span className="text-[11px] text-[#555]">{tool.connection}</span>
                </label>
                {draft.enabled && (
                  <div className="space-y-1.5 pl-6">
                    <input
                      type="text"
                      placeholder={tool.recipientField}
                      value={draft.recipient}
                      onChange={(e) => updateDraft(key, { recipient: e.target.value })}
                      className="w-full bg-[#0a0a0c] border border-[#1f1f23] rounded px-2 py-1 text-[12px] text-[#ededed] outline-none focus:border-[#333]"
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
                        className="w-full bg-[#0a0a0c] border border-[#1f1f23] rounded px-2 py-1 text-[12px] text-[#ededed] outline-none focus:border-[#333]"
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={triggerOnFail}
            onChange={(e) => setTriggerOnFail(e.target.checked)}
            className="accent-white"
          />
          <span className="text-[13px] text-[#ededed]">Notify on jig failure</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving || tools.length === 0}
          className="text-[12px] text-[#ededed] rounded-md border border-[#1f1f23] bg-[#1a1a1d] hover:bg-[#222] px-3 py-1.5 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={onTest}
          disabled={testing || tools.length === 0}
          className="text-[12px] text-[#888] rounded-md border border-[#1f1f23] hover:text-[#ededed] hover:bg-[#111] px-3 py-1.5 disabled:opacity-50"
        >
          {testing ? "Sending…" : "Send test"}
        </button>
        {status && <span className="text-[11px] text-[#888]">{status}</span>}
      </div>
    </div>
  );
}
