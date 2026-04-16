"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TextInput } from "@/components/input";
import { ServiceIcon } from "@/components/service-icon";
import { LoadingState, Notice } from "@/components/state-panel";
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

function emptyDraftFor(tool: NotificationCapableTool): ChannelDraft {
  return {
    ...DEFAULT_DRAFT,
    extra: Object.fromEntries(tool.extraRequired.map((key) => [key, ""])),
  };
}

function formatFieldLabel(field: string): string {
  return field
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function NotificationsSettings({ onReset }: { onReset?: () => Promise<void> | void } = {}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveConfirmed, setSaveConfirmed] = useState(false);
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
            : emptyDraftFor(t);
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

  useEffect(() => {
    if (!saveConfirmed) return;
    const timer = window.setTimeout(() => setSaveConfirmed(false), 1800);
    return () => window.clearTimeout(timer);
  }, [saveConfirmed]);

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
    setSaveConfirmed(false);
    setStatus(null);
    try {
      await saveNotificationSettings(buildSettings());
      setSaveConfirmed(true);
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
    setSaveConfirmed(false);
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
    return <LoadingState message="Loading notification settings…" />;
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

      <div className="rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-3.5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h4 className="text-[13px] font-medium text-[#ededed]">Notifications</h4>
            <p className="text-[11px] leading-relaxed text-[#666]">
              Configure failure alerts and test delivery. Available channels come from connected tools classified as notification-capable.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-input)] px-2 py-1">
            <span className="text-[10px] text-[var(--text-dim)]">Notify on failures</span>
            <button
              type="button"
              role="switch"
              aria-checked={triggerOnFail}
              aria-label="Notify on jig failure"
              onClick={() => {
                setSaveConfirmed(false);
                setTriggerOnFail((current) => !current);
              }}
              className={`relative inline-flex h-[18px] w-8 rounded-full border transition-colors duration-150 ${
                triggerOnFail
                  ? "border-emerald-400/35 bg-emerald-500/80"
                  : "border-[var(--border-strong)] bg-[var(--surface-muted)]"
              }`}
            >
              <span
                className={`absolute top-[1px] h-[14px] w-[14px] rounded-full bg-white transition-transform duration-150 ${
                  triggerOnFail ? "translate-x-[15px]" : "translate-x-[1px]"
                }`}
              />
            </button>
          </div>
        </div>

        {!triggerOnFail ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-input)] px-3 py-2.5 text-[11px] text-[var(--text-muted)]">
            Delivery is paused. Channel settings stay saved here and will resume when you turn failure notifications back on.
          </div>
        ) : null}

        {tools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#242428] bg-[#0d0d0f] px-4 py-6 text-center">
            <p className="text-[12px] text-[#6b6b72]">
              No notification-capable tools detected yet. Run <code className="text-[#9a9aa3]">jig connect</code> to add one.
            </p>
          </div>
        ) : (
          <div
            className={`space-y-1.5 transition-[opacity,filter] duration-200 ${
              triggerOnFail ? "" : "opacity-60 saturate-[0.35]"
            }`}
          >
            {tools.map((tool) => {
              const key = channelKey(tool.connection, tool.tool);
              const draft = drafts[key] ?? emptyDraftFor(tool);
              const fields = [tool.recipientField, ...tool.extraRequired];
              return (
                <div
                  key={key}
                  className={`overflow-hidden rounded-xl border transition-colors ${
                    draft.enabled
                      ? triggerOnFail
                        ? "border-emerald-500/16 bg-[var(--surface)]"
                        : "border-[var(--border-strong)] bg-[var(--surface)]"
                      : "border-[#1f1f23] bg-[#0d0d0f]"
                  }`}
                >
                  <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => updateDraft(key, { enabled: e.target.checked })}
                      className="peer sr-only"
                    />
                    <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border border-[var(--border-strong)] bg-[var(--surface-input)] text-white transition-[background-color,border-color,box-shadow] duration-150 peer-checked:border-emerald-500/50 peer-checked:bg-emerald-500 peer-focus-visible:shadow-[0_0_0_1px_rgba(16,185,129,0.35)]">
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3 w-3 opacity-0 transition-opacity duration-150 peer-checked:opacity-100"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M3.5 8.25 6.5 11 12.5 5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-muted)]">
                        <ServiceIcon name={tool.connection} size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium text-[#ededed]">{tool.label}</span>
                          <span className="rounded-full border border-[#232327] bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] text-[#666]">
                            {tool.connection}
                          </span>
                        </div>
                        {tool.description ? (
                          <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--text-dim)]">{tool.description}</p>
                        ) : null}
                      </div>
                    </div>
                  </label>
                  {draft.enabled && (
                    <div className="border-t border-[var(--border)] bg-[var(--surface-input)]/55 px-3 py-2">
                      <div className={`grid gap-2 ${fields.length > 1 ? "md:grid-cols-2" : ""}`}>
                        <label className="space-y-1">
                          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
                            {formatFieldLabel(tool.recipientField)}
                          </span>
                          <TextInput
                            type="text"
                            value={draft.recipient}
                            placeholder={formatFieldLabel(tool.recipientField)}
                            inputClassName="ui-input-compact"
                            onChange={(e) => updateDraft(key, { recipient: e.target.value })}
                          />
                        </label>
                        {tool.extraRequired.map((field) => (
                          <label key={field} className="space-y-1">
                            <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
                              {formatFieldLabel(field)}
                            </span>
                            <TextInput
                              type="text"
                              value={draft.extra[field] ?? ""}
                              placeholder={formatFieldLabel(field)}
                              inputClassName="ui-input-compact"
                              onChange={(e) =>
                                updateDraft(key, { extra: { ...draft.extra, [field]: e.target.value } })
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            onClick={onSave}
            disabled={saving || !hasEditableChannels}
            variant={saveConfirmed ? "successOutline" : "success"}
            size="md"
          >
            {saving ? "Saving…" : saveConfirmed ? "Saved" : "Save"}
          </Button>
          <Button onClick={onTest} disabled={testing || !hasEditableChannels} variant="subtle" size="md">
            {testing ? "Sending…" : "Send test"}
          </Button>
        </div>
        {status && (
          <Notice tone={tone === "error" ? "danger" : tone === "success" ? "success" : "neutral"}>
            {status}
          </Notice>
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
          <Button onClick={() => setConfirmResetOpen(true)} disabled={resetting} variant="danger" size="md">
            {resetting ? "Deleting…" : "Delete Local Data"}
          </Button>
        </div>
      </div>
    </div>
  );
}
