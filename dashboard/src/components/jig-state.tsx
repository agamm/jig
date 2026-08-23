"use client";

import { useState } from "react";
import type { JigMemoryEntry, JigReminderEntry } from "@shared/api";
import { clearJigMemory, deleteJigMemoryKey, cancelJigReminder } from "@/lib/api";
import { toast } from "@/components/toast";

function formatDue(iso: string): string {
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60_000);
  const rel =
    mins < 1 ? "now"
    : mins < 60 ? `${mins}m`
    : abs < 24 * 3_600_000 ? `${Math.round(mins / 60)}h`
    : `${Math.round(mins / 1440)}d`;
  const when = d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
  return diffMs >= 0 ? `${when} (in ${rel})` : `${when} (${rel} ago, overdue)`;
}

/**
 * A jig's cross-run state, shown so the user can see and correct what it
 * remembers. A to-do list you cannot inspect or fix is not one you would trust
 * to hold a real to-do.
 */
export function JigStatePanel({
  jigId,
  memory,
  reminders,
  onRefresh,
}: {
  jigId: string;
  memory: JigMemoryEntry[];
  reminders: JigReminderEntry[];
  onRefresh?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(token: string, action: () => Promise<unknown>, failure: string) {
    setBusy(token);
    try {
      await action();
      await onRefresh?.();
    } catch {
      toast.error(failure);
    } finally {
      setBusy(null);
    }
  }

  if (memory.length === 0 && reminders.length === 0) {
    return (
      <p className="text-[10px] text-[#555]">
        Nothing stored yet. Anything the jig saves with <code className="font-mono">ctx.memory</code> or
        schedules with <code className="font-mono">ctx.remind</code> shows up here.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {reminders.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[9px] text-[#444] uppercase tracking-wider">
              Scheduled ({reminders.length})
            </span>
          </div>
          <div className="space-y-1">
            {reminders.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="text-[10px] font-mono text-[#ccc] truncate">{r.key ?? "(no key)"}</p>
                  <p className="text-[10px] text-[#666]">{formatDue(r.dueAt)}</p>
                </div>
                {r.key && (
                  <button
                    type="button"
                    disabled={busy === `r:${r.key}`}
                    onClick={() => run(`r:${r.key}`, () => cancelJigReminder(jigId, r.key!), "Failed to cancel")}
                    className="shrink-0 text-[9px] text-[#666] hover:text-rose-400 transition-colors disabled:opacity-50"
                  >
                    cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {memory.length > 0 && (
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-[9px] text-[#444] uppercase tracking-wider">
              Remembered ({memory.length})
            </span>
            <button
              type="button"
              disabled={busy === "clear"}
              onClick={() => run("clear", () => clearJigMemory(jigId), "Failed to clear")}
              className="text-[9px] text-[#666] hover:text-rose-400 transition-colors disabled:opacity-50"
            >
              clear all
            </button>
          </div>
          <div className="space-y-1">
            {memory.map((entry) => (
              <MemoryRow
                key={entry.key}
                entry={entry}
                busy={busy === `m:${entry.key}`}
                onDelete={() => run(`m:${entry.key}`, () => deleteJigMemoryKey(jigId, entry.key), "Failed to delete")}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  entry,
  busy,
  onDelete,
}: {
  entry: JigMemoryEntry;
  busy: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Values run to 64KB; showing them all expanded would bury the key list.
  const preview = entry.value.replace(/\s+/g, " ").trim();

  return (
    <div className="rounded-md bg-[#111113] border border-[#1f1f23] px-2.5 py-1.5">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 text-left"
        >
          <p className="text-[10px] font-mono text-[#ccc] truncate">{entry.key}</p>
          {!open && <p className="text-[10px] text-[#666] truncate">{preview}</p>}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="shrink-0 text-[9px] text-[#666] hover:text-rose-400 transition-colors disabled:opacity-50"
        >
          delete
        </button>
      </div>
      {open && (
        <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px] font-mono text-[#888]">
          {entry.value}
        </pre>
      )}
    </div>
  );
}
