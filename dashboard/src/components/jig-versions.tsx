"use client"

import { useEffect, useMemo, useState } from "react"
import type { JigVersionRecord } from "@shared/api"
import { Button } from "@/components/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState, LoadingState, Notice } from "@/components/state-panel"
import { toast } from "@/components/toast"
import { restoreToPending } from "@/lib/api"
import { useVersionsV2 } from "@/lib/swr"

const DEFAULT_VISIBLE_HISTORY_ROWS = 3

function formatVersionDate(ts: number): { date: string; time: string } {
  const d = new Date(ts)
  return {
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
  }
}

function PromptOutput({ prompt }: { prompt: string }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-[#4b4b51]">Prompt used</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[#1f1f23] bg-[#0a0a0b] p-3 text-[10px] leading-relaxed text-[#b8b8be]">
        {prompt}
      </pre>
    </div>
  )
}

function VersionRow({
  version,
  isActive,
  expanded,
  onToggle,
  onRestore,
}: {
  version: JigVersionRecord
  isActive: boolean
  expanded: boolean
  onToggle: () => void
  onRestore: () => void
}) {
  const { date, time } = formatVersionDate(version.createdAt)
  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-[#151517]"
      >
        <span className="w-14 shrink-0 font-mono text-[10px] text-[#555]">v{version.id}</span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[10px] text-[#d0d0d4]">{version.message ?? `version ${version.id}`}</span>
          <span className="text-[9px] text-[#444]">
            {date} {time}
            <span className="ml-2 text-[#3a3a3f]">— {version.author}</span>
          </span>
        </div>
        <span className={`shrink-0 text-[9px] text-[#333] transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>
          &#9656;
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[#1a1a1d] bg-[#0f0f11] px-3 py-2.5 space-y-2.5">
          {version.prompt && <PromptOutput prompt={version.prompt} />}
          {!isActive && (
            <div className="flex items-center justify-end">
              <Button onClick={onRestore} variant="accent" size="xs">
                Restore as pending
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function JigVersions({
  jigId,
  onRestored,
  refreshKey,
}: {
  jigId: string
  /** Fired after restoreToPending succeeds. Caller should revalidate pending. */
  onRestored?: () => Promise<void> | void
  refreshKey?: string
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [confirmRestoreId, setConfirmRestoreId] = useState<number | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const { data, isLoading, error, mutate } = useVersionsV2(jigId)

  useEffect(() => {
    setSelectedId(null)
    setConfirmRestoreId(null)
    setRestoring(false)
    setShowAll(false)
  }, [jigId])

  useEffect(() => { void mutate() }, [refreshKey, mutate])

  const active = data?.active ?? null
  const history = data?.history ?? []
  const visible = useMemo(() => showAll ? history : history.slice(0, DEFAULT_VISIBLE_HISTORY_ROWS), [history, showAll])

  const handleRestore = async () => {
    if (confirmRestoreId == null) return
    setRestoring(true)
    try {
      await restoreToPending(jigId, confirmRestoreId)
      setConfirmRestoreId(null)
      toast.success("Version staged as pending — review and approve in the banner above")
      await mutate()
      await onRestored?.()
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to restore")
    } finally {
      setRestoring(false)
    }
  }

  if (isLoading) return <LoadingState message="Loading history…" className="py-4" />
  if (error && !data) {
    return (
      <Notice
        tone="danger"
        title="Couldn't load history"
        className="py-2"
        actions={<Button onClick={() => mutate()} variant="subtle" size="xs">Retry</Button>}
      >
        {error?.message ?? "Failed to load"}
      </Notice>
    )
  }
  if (!active && history.length === 0) {
    return <EmptyState title="No saved versions yet" className="py-4" />
  }

  return (
    <>
      <ConfirmDialog
        open={confirmRestoreId != null}
        title="Restore this version?"
        message="The selected version will be staged as a pending change. Review the diff in the banner above and click Approve to make it active."
        confirmLabel="Stage as Pending"
        loading={restoring}
        onConfirm={handleRestore}
        onClose={() => !restoring && setConfirmRestoreId(null)}
      />

      <div className="space-y-2">
        {active && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#101012] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <span className="rounded-full border border-[#26262b] bg-[#16161a] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-[#8b8b91]">
                Current
              </span>
              <span className="font-mono text-[10px] text-[#555]">v{active.id}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-[#b8b8be]">
                {active.message ?? `version ${active.id}`}
              </span>
            </div>
          </div>
        )}

        {visible.length > 0 && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d]">
            {visible.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                isActive={false}
                expanded={selectedId === version.id}
                onToggle={() => setSelectedId(selectedId === version.id ? null : version.id)}
                onRestore={() => setConfirmRestoreId(version.id)}
              />
            ))}
          </div>
        )}

        {history.length > DEFAULT_VISIBLE_HISTORY_ROWS && (
          <div className="flex justify-center">
            <Button onClick={() => setShowAll((value) => !value)} variant="subtle" size="xs">
              {showAll ? "Hide history" : `Show ${history.length - DEFAULT_VISIBLE_HISTORY_ROWS} more`}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
