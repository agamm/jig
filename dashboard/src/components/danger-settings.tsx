"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Notice } from "@/components/state-panel";
import { changePassword, resetLocalState } from "@/lib/api";

export function DangerSettings({ onReset }: { onReset?: () => Promise<void> | void } = {}) {
  const [newPassword, setNewPassword] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwStatus, setPwStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  const [resetting, setResetting] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [resetStatus, setResetStatus] = useState<{ tone: "success" | "danger"; message: string } | null>(null);

  async function onChangePassword() {
    setPwStatus(null);
    if (newPassword.length < 8) {
      setPwStatus({ tone: "danger", message: "Password must be at least 8 characters." });
      return;
    }
    setPwSaving(true);
    try {
      await changePassword(newPassword);
      setNewPassword("");
      setPwStatus({ tone: "success", message: "Password updated. Other sessions will need to unlock again." });
    } catch (e) {
      setPwStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setPwSaving(false);
    }
  }

  async function onResetConfirm() {
    setResetting(true);
    setResetStatus(null);
    try {
      const result = await resetLocalState();
      setConfirmResetOpen(false);
      const deletedJigs = Array.isArray(result.deletedJigs) ? result.deletedJigs : [];
      const disconnectedConnections = Array.isArray(result.disconnectedConnections) ? result.disconnectedConnections : [];
      const disconnected = disconnectedConnections.length;
      setResetStatus({
        tone: "success",
        message:
          disconnected > 0
            ? `Reset complete. Removed ${deletedJigs.length} jig${deletedJigs.length === 1 ? "" : "s"} and disconnected ${disconnected} connection${disconnected === 1 ? "" : "s"}.`
            : `Reset complete. Removed ${deletedJigs.length} jig${deletedJigs.length === 1 ? "" : "s"}.`,
      });
      await onReset?.();
    } catch (e) {
      setResetStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={confirmResetOpen}
        title="Start from scratch?"
        message="This will delete all local jig files, clear the local SQLite database, and disconnect saved connections on this machine. The app will return to onboarding."
        confirmLabel="Delete Everything"
        destructive
        loading={resetting}
        onConfirm={onResetConfirm}
        onClose={() => !resetting && setConfirmResetOpen(false)}
      />

      <div className="rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-3">
        <div>
          <h4 className="text-[13px] font-medium text-[#ededed]">Change password</h4>
          <p className="mt-1 text-[11px] leading-relaxed text-[#666]">
            Rotates the system password and re-encrypts every stored credential. You’re already unlocked in this session, so only the new password is needed. Other browsers/sessions will have to unlock again.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="block text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-dim)]">
            New password (min 8 chars)
          </span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newPassword.length >= 8 && !pwSaving) onChangePassword();
            }}
            autoComplete="new-password"
            className="ui-input ui-input-compact"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button
            onClick={onChangePassword}
            disabled={pwSaving || newPassword.length < 8}
            variant="success"
            size="md"
          >
            {pwSaving ? "Saving…" : "Update password"}
          </Button>
          {pwStatus ? (
            <span
              className={`text-[11px] ${pwStatus.tone === "success" ? "text-emerald-300" : "text-rose-300"}`}
            >
              {pwStatus.message}
            </span>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] px-4 py-4 space-y-3">
        <div>
          <p className="text-[13px] text-rose-100">Start from scratch</p>
          <p className="mt-1 text-[11px] leading-relaxed text-rose-100/60">
            Deletes all local jigs, clears saved connection auth on this machine, and returns the dashboard to onboarding.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setConfirmResetOpen(true)} disabled={resetting} variant="danger" size="md">
            {resetting ? "Deleting…" : "Delete Local Data"}
          </Button>
          {resetStatus ? (
            <Notice tone={resetStatus.tone}>{resetStatus.message}</Notice>
          ) : null}
        </div>
      </div>
    </div>
  );
}
