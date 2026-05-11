"use client"

import { useState } from "react"
import type { PendingState } from "@shared/api"
import { Button } from "@/components/button"
import { DiffOutput } from "@/components/diff-output"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { approvePending, discardPending } from "@/lib/api"
import { toast } from "@/components/toast"

type AgentStatus = "thinking" | "tool-calling" | "waiting" | "done" | "error" | "idle"

const ACTIVE_STATUSES = new Set<AgentStatus>(["thinking", "tool-calling", "waiting"])

/**
 * Shows the current pending change for a jig. Three visual states driven by
 * the agent session status: working (no actions), ready-to-review (full
 * controls), or idle/no-pending (nothing rendered).
 *
 * Approve / Discard / View Diff are the only actions. Approve is disabled
 * while the agent is mid-stream so the user doesn't cut it off; discard
 * stays enabled so the user can always bail.
 */
export function PendingChangesBanner({
  jigId,
  pending,
  agentStatus,
  onApproved,
  onDiscarded,
}: {
  jigId: string
  pending: PendingState
  agentStatus: AgentStatus
  onApproved?: () => void | Promise<void>
  onDiscarded?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null)
  const agentWorking = ACTIVE_STATUSES.has(agentStatus)

  const handleApprove = async () => {
    if (agentWorking) return
    setBusy("approve")
    try {
      await approvePending(jigId)
      toast.success("Changes approved")
      await onApproved?.()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to approve")
    } finally {
      setBusy(null)
    }
  }

  const handleDiscard = async () => {
    setBusy("discard")
    try {
      await discardPending(jigId)
      toast.success("Changes discarded")
      setConfirmDiscard(false)
      await onDiscarded?.()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to discard")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/[0.04]">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        <div className="flex-1 text-[11px] tracking-wide">
          {agentWorking ? (
            <span className="text-amber-200">Agent working — pending changes will appear when ready</span>
          ) : (
            <>
              <span className="text-amber-200">Pending changes</span>
              <span className="ml-2 text-[#8b8b91]">
                <span className="text-emerald-300">+{pending.addedLines}</span>
                <span className="mx-1 text-[#4b4b51]">/</span>
                <span className="text-rose-300">−{pending.removedLines}</span>
                <span className="ml-1 text-[#5a5a60]">lines</span>
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="subtle" onClick={() => setOpen((o) => !o)} disabled={agentWorking}>
            {open ? "Hide diff" : "View diff"}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setConfirmDiscard(true)} disabled={busy != null}>
            {busy === "discard" ? "..." : "Discard"}
          </Button>
          <Button size="sm" variant="success" onClick={handleApprove} disabled={agentWorking || busy != null}>
            {busy === "approve" ? "..." : "Approve"}
          </Button>
        </div>
      </div>

      {open && !agentWorking && (
        <div className="border-t border-[#1f1f23] p-3">
          <DiffOutput diff={pending.diff} maxHeight="max-h-96" />
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard pending changes?"
        message="This will permanently drop the proposed changes. You can re-create them by asking the agent again."
        confirmLabel="Discard"
        destructive
        loading={busy === "discard"}
        onConfirm={handleDiscard}
        onClose={() => busy !== "discard" && setConfirmDiscard(false)}
      />
    </div>
  )
}
