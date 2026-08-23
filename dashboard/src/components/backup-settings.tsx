"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Notice } from "@/components/state-panel";
import { downloadBackup, restoreBackup } from "@/lib/api";
import type { BackupRestoreResponse } from "@shared/api";

type Status = { tone: "success" | "danger"; message: string } | null;

function planSummary(plan: BackupRestoreResponse["plan"]): string {
  const parts: string[] = [];
  if (plan.jigs.added.length) parts.push(`${plan.jigs.added.length} new jig${plan.jigs.added.length === 1 ? "" : "s"}`);
  if (plan.jigs.overwritten.length) parts.push(`${plan.jigs.overwritten.length} jig${plan.jigs.overwritten.length === 1 ? "" : "s"} overwritten`);
  if (plan.credentials) parts.push(`${plan.credentials} credential${plan.credentials === 1 ? "" : "s"}`);
  if (plan.connections) parts.push(`${plan.connections} custom server${plan.connections === 1 ? "" : "s"}`);
  if (plan.schemas) parts.push(`${plan.schemas} schema${plan.schemas === 1 ? "" : "s"}`);
  if (plan.memory) parts.push(`${plan.memory} memory entr${plan.memory === 1 ? "y" : "ies"}`);
  return parts.length ? parts.join(", ") : "nothing";
}

export function BackupSettings({ onRestored }: { onRestored?: () => Promise<void> | void } = {}) {
  const [includeCredentials, setIncludeCredentials] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<Status>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupRestoreResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<Status>(null);

  async function onDownload() {
    setDownloading(true);
    setDownloadStatus(null);
    try {
      await downloadBackup(includeCredentials);
      setDownloadStatus({ tone: "success", message: "Backup downloaded." });
    } catch (e) {
      setDownloadStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setDownloading(false);
    }
  }

  // Picking a file only ever previews. Nothing is written until the confirm.
  async function onPick(picked: File | null) {
    setFile(picked);
    setPreview(null);
    setRestoreStatus(null);
    if (!picked) return;
    setBusy(true);
    try {
      setPreview(await restoreBackup(picked, { dryRun: true }));
    } catch (e) {
      setRestoreStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function onRestoreConfirm() {
    if (!file) return;
    setBusy(true);
    setRestoreStatus(null);
    try {
      const result = await restoreBackup(file, { force: false });
      setConfirmOpen(false);
      setFile(null);
      setPreview(null);
      if (fileInput.current) fileInput.current.value = "";
      setRestoreStatus({
        tone: "success",
        message: result.plan.credentialsSkipped
          ? `Restored ${planSummary(result.plan)}. Credentials were skipped because this instance has a different password; reconnect each server.`
          : `Restored ${planSummary(result.plan)}.`,
      });
      await onRestored?.();
    } catch (e) {
      setRestoreStatus({ tone: "danger", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog
        open={confirmOpen}
        title="Restore from this backup?"
        message={
          preview
            ? `This will apply ${planSummary(preview.plan)}. Jigs with the same id are overwritten with the backup's version. This cannot be undone.`
            : "This will overwrite jigs with the same id. This cannot be undone."
        }
        confirmLabel="Restore"
        destructive
        loading={busy}
        onConfirm={onRestoreConfirm}
        onClose={() => !busy && setConfirmOpen(false)}
      />

      <div className="rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-3">
        <div>
          <h4 className="text-[13px] font-medium text-[#ededed]">Download a backup</h4>
          <p className="mt-1 text-[11px] leading-relaxed text-[#666]">
            A .zip holding your jigs and their code, schedules, connections, tool permissions,
            settings and jig memory. Run history and logs are not included. Your jigs are plain
            .ts files inside, so you can open the archive and read them anywhere.
          </p>
        </div>
        <label className="flex items-start gap-2 text-[11px] text-[#999]">
          <input
            type="checkbox"
            checked={includeCredentials}
            onChange={(e) => setIncludeCredentials(e.target.checked)}
            className="mt-[2px]"
          />
          <span>
            Include credentials.
            <span className="text-[#666]">
              {" "}
              They stay encrypted exactly as stored, so restoring them needs this instance&apos;s
              password. Untick to produce an archive safe to share.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-2">
          <Button onClick={onDownload} disabled={downloading}>
            {downloading ? "Preparing…" : "Download backup"}
          </Button>
        </div>
        {downloadStatus && <Notice tone={downloadStatus.tone}>{downloadStatus.message}</Notice>}
      </div>

      <div className="rounded-xl border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-3">
        <div>
          <h4 className="text-[13px] font-medium text-[#ededed]">Restore from a backup</h4>
          <p className="mt-1 text-[11px] leading-relaxed text-[#666]">
            Choosing a file only previews it. Nothing changes until you confirm.
          </p>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          className="block w-full text-[11px] text-[#999] file:mr-3 file:rounded-md file:border-0 file:bg-[#1f1f23] file:px-3 file:py-1.5 file:text-[11px] file:text-[#ededed]"
        />

        {busy && !preview && <p className="text-[11px] text-[#666]">Reading backup…</p>}

        {preview && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#0a0a0b] px-3 py-2.5 space-y-1.5">
            <p className="text-[11px] text-[#999]">
              From {new Date(preview.manifest.createdAt).toLocaleString()}, written by jig {preview.manifest.jigVersion}.
            </p>
            <p className="text-[11px] text-[#ededed]">Would apply {planSummary(preview.plan)}.</p>
            {preview.plan.jigs.overwritten.length > 0 && (
              <p className="text-[11px] text-[#f59e0b]">
                Overwrites: {preview.plan.jigs.overwritten.join(", ")}
              </p>
            )}
            {preview.plan.warnings.map((w) => (
              <p key={w} className="text-[11px] text-[#f59e0b]">{w}</p>
            ))}
          </div>
        )}

        {preview && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setConfirmOpen(true)} disabled={busy}>
              Restore
            </Button>
            <Button
              variant="subtle"
              onClick={() => {
                setFile(null);
                setPreview(null);
                if (fileInput.current) fileInput.current.value = "";
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        )}

        {restoreStatus && <Notice tone={restoreStatus.tone}>{restoreStatus.message}</Notice>}
      </div>
    </div>
  );
}
