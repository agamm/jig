"use client"

import { useState } from "react"
import type { PendingState } from "@shared/api"
import { Button } from "@/components/button"
import { DiffOutput } from "@/components/diff-output"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { approvePending, discardPending } from "@/lib/api"
import { toast } from "@/components/toast"

/**
 * Shows the current pending version for a jig (a reply-to-email edit, an
 * auto-repair, or a CLI push). Approve / Discard / View Diff are the only
 * actions; nothing renders when there is no pending version.
 */
export function PendingChangesBanner({
  jigId,
  pending,
  onApproved,
  onDiscarded,
}: {
  jigId: string
  pending: PendingState
  onApproved?: () => void | Promise<void>
  onDiscarded?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [busy, setBusy] = useState<"approve" | "discard" | null>(null)

  const handleApprove = async () => {
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
          <span className="text-amber-200">Pending changes</span>
          <span className="ml-2 text-[#8b8b91]">
            <span className="text-emerald-300">+{pending.addedLines}</span>
            <span className="mx-1 text-[#4b4b51]">/</span>
            <span className="text-rose-300">−{pending.removedLines}</span>
            <span className="ml-1 text-[#5a5a60]">lines</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="subtle" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide diff" : "View diff"}
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setConfirmDiscard(true)} disabled={busy != null}>
            {busy === "discard" ? "..." : "Discard"}
          </Button>
          <Button size="sm" variant="success" onClick={handleApprove} disabled={busy != null}>
            {busy === "approve" ? "..." : "Approve"}
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-[#1f1f23] p-3">
          <DiffOutput diff={pending.diff} maxHeight="max-h-96" />
        </div>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard pending changes?"
        message="This will permanently drop the proposed changes. You can push a new version from your paired checkout."
        confirmLabel="Discard"
        destructive
        loading={busy === "discard"}
        onConfirm={handleDiscard}
        onClose={() => busy !== "discard" && setConfirmDiscard(false)}
      />
    </div>
  )
}
