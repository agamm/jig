"use client"

import { useEffect, useMemo, useState } from "react"
import type { JigVersion, JigVersionDetail } from "@shared/api"
import { Button } from "@/components/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState, LoadingState, Notice } from "@/components/state-panel"
import { toast } from "@/components/toast"
import { fetchJigVersionDetail, restoreJigVersion } from "@/lib/api"
import { trimGitDiffHeaders } from "@/lib/git-diff"
import { useJigVersions } from "@/lib/swr"

const DEFAULT_VISIBLE_HISTORY_ROWS = 0

function DiffOutput({ diff }: { diff: string }) {
  const normalizedDiff = trimGitDiffHeaders(diff)
  const visibleLines = normalizedDiff
    .split("\n")
    .filter((line) => !line.startsWith("@@"))

  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-[#1f1f23] bg-[#0a0a0b] p-3 text-[10px] leading-relaxed">
      {visibleLines.map((line, index) => {
        const cls = line.startsWith("+")
          ? "text-emerald-300"
          : line.startsWith("-")
            ? "text-rose-300"
            : "text-[#8b8b91]"
        return <div key={index} className={cls}>{line || " "}</div>
      })}
    </pre>
  )
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

export function JigVersions({
  jigId,
  onRestored,
}: {
  jigId: string
  onRestored?: () => Promise<void> | void
}) {
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [detailsBySha, setDetailsBySha] = useState<Record<string, JigVersionDetail | undefined>>({})
  const [detailErrorsBySha, setDetailErrorsBySha] = useState<Record<string, string | undefined>>({})
  const [loadingSha, setLoadingSha] = useState<string | null>(null)
  const [confirmRestoreSha, setConfirmRestoreSha] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const { data: versions, isLoading: loading, error, mutate: reloadVersions } = useJigVersions(jigId)

  useEffect(() => {
    setSelectedSha(null)
    setDetailsBySha({})
    setDetailErrorsBySha({})
    setLoadingSha(null)
    setConfirmRestoreSha(null)
    setRestoring(false)
    setShowAll(false)
  }, [jigId])

  const currentVersion = versions?.[0] ?? null
  const historicalVersions = useMemo(() => {
    if (!versions || versions.length <= 1) return []
    return versions.slice(1)
  }, [versions])

  const visibleVersions = useMemo(
    () => showAll ? historicalVersions : historicalVersions.slice(0, DEFAULT_VISIBLE_HISTORY_ROWS),
    [historicalVersions, showAll]
  )

  const loadVersionDetail = async (sha: string) => {
    setDetailErrorsBySha((current) => ({ ...current, [sha]: undefined }))
    setLoadingSha(sha)
    try {
      const nextDetail = await fetchJigVersionDetail(jigId, sha)
      setDetailsBySha((current) => ({ ...current, [sha]: nextDetail }))
    } catch (nextError: any) {
      const message = nextError?.message ?? "Failed to load version"
      setDetailErrorsBySha((current) => ({ ...current, [sha]: message }))
      toast.error(message)
    } finally {
      setLoadingSha((current) => (current === sha ? null : current))
    }
  }

  const viewVersion = async (sha: string) => {
    if (selectedSha === sha) {
      setSelectedSha(null)
      return
    }

    setSelectedSha(sha)
    if (detailsBySha[sha] || detailErrorsBySha[sha]) {
      return
    }

    await loadVersionDetail(sha)
  }

  const handleRestore = async () => {
    if (!confirmRestoreSha) return
    setRestoring(true)
    try {
      await restoreJigVersion(jigId, confirmRestoreSha)
      setConfirmRestoreSha(null)
      await reloadVersions()
      await onRestored?.()
      if (selectedSha === confirmRestoreSha) {
        await loadVersionDetail(confirmRestoreSha)
      }
      toast.success("Version restored")
    } catch (restoreError: any) {
      toast.error(restoreError?.message ?? "Failed to restore version")
    } finally {
      setRestoring(false)
    }
  }

  if (loading) return <LoadingState message="Loading history…" className="py-4" />
  if (error && !versions) {
    return (
      <Notice
        tone="danger"
        title="Couldn’t load history"
        className="py-2"
        actions={<Button onClick={() => reloadVersions()} variant="subtle" size="xs">Retry</Button>}
      >
        {error?.message ?? "Failed to load"}
      </Notice>
    )
  }
  if (!versions || versions.length === 0) return <EmptyState title="No version history yet" className="py-4" />

  return (
    <>
      <ConfirmDialog
        open={!!confirmRestoreSha}
        title="Restore this version?"
        message="This will replace the current jig code with the selected historical version and create a new restore commit."
        confirmLabel="Restore Version"
        loading={restoring}
        onConfirm={handleRestore}
        onClose={() => !restoring && setConfirmRestoreSha(null)}
      />

      <div className="space-y-2">
        {currentVersion && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#101012] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <span className="rounded-full border border-[#26262b] bg-[#16161a] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.18em] text-[#8b8b91]">
                Current
              </span>
              <span className="font-mono text-[10px] text-[#555]">{currentVersion.sha.slice(0, 7)}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-[#b8b8be]">{currentVersion.message}</span>
            </div>
          </div>
        )}
        {visibleVersions.length > 0 && <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d]">
        {visibleVersions.map((version) => {
          const date = new Date(version.date)
          const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
          const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
          const expanded = selectedSha === version.sha
          const detail = detailsBySha[version.sha]
          const detailError = detailErrorsBySha[version.sha]
          const detailLoading = loadingSha === version.sha

          return (
            <div key={version.sha}>
              <button
                onClick={() => viewVersion(version.sha)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-[#151517]"
              >
                <span className="w-14 shrink-0 text-[10px] font-mono text-[#555]">{version.sha.slice(0, 7)}</span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] text-[#d0d0d4]">{version.message}</span>
                  <span className="text-[9px] text-[#444]">{dateStr} {timeStr}</span>
                </div>
                <span className={`shrink-0 text-[9px] text-[#333] transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}>&#9656;</span>
              </button>

              {expanded && (
                <div className="border-t border-[#1a1a1d] bg-[#0f0f11] px-3 py-2.5">
                  {detailLoading ? (
                    <p className="text-[10px] text-[#555]">Loading version details...</p>
                  ) : detail ? (
                    <div className="space-y-2.5">
                      {detail.prompt && <PromptOutput prompt={detail.prompt} />}

                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] text-[#4b4b51]">
                          {detail.hasChanges ? "Diff vs current" : "Identical to current code"}
                        </span>
                        {detail.hasChanges && (
                          <Button
                            onClick={() => setConfirmRestoreSha(version.sha)}
                            variant="accent"
                            size="xs"
                          >
                            Restore
                          </Button>
                        )}
                      </div>

                      {detail.hasChanges ? (
                        <DiffOutput diff={detail.diff} />
                      ) : (
                        <div className="rounded-md border border-[#1f1f23] bg-[#0a0a0b] px-3 py-2 text-[10px] text-[#555]">
                          This historical version resolves to the same code as the current jig.
                        </div>
                      )}
                    </div>
                  ) : detailError ? (
                    <div className="space-y-2">
                      <p className="text-[10px] text-[#555]">{detailError}</p>
                      <Button
                        onClick={() => loadVersionDetail(version.sha)}
                        variant="subtle"
                        size="xs"
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <p className="text-[10px] text-[#555]">Unable to load version details.</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
        </div>}
        {historicalVersions.length > 0 && (
          <div className="flex justify-center">
            <Button onClick={() => setShowAll((value) => !value)} variant="subtle" size="xs">
              {showAll ? "Hide history" : `Show ${historicalVersions.length} more`}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
