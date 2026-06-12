"use client"

import { useEffect, useState } from "react"
import { mutate } from "swr"
import { Button } from "@/components/button"
import { toast } from "@/components/toast"
import { applyModelUpgrade, dismissModelUpgrade } from "@/lib/api"
import { SLOT_META, fmtContext, fmtPrice } from "@/components/models-settings"
import type { ModelSlot, ModelUpgradeSuggestion, OpenRouterModelInfo } from "@shared/api"

function priceLabel(usdPerM: number): string {
  const fmt = fmtPrice(usdPerM)
  return fmt === "free" ? "Free" : `${fmt}/M`
}

function ModelStats({ model }: { model: OpenRouterModelInfo }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
      <span>{priceLabel(model.blendedPriceUsdPerM)}</span>
      <span className="opacity-50">·</span>
      <span>rank #{model.rank + 1}</span>
      <span className="opacity-50">·</span>
      <span>{fmtContext(model.contextLength)} ctx</span>
      {model.supportsTools && (
        <>
          <span className="opacity-50">·</span>
          <span>tools</span>
        </>
      )}
      {model.supportsReasoning && (
        <>
          <span className="opacity-50">·</span>
          <span>reasoning</span>
        </>
      )}
    </div>
  )
}

function SuggestionCard({
  s,
  onActioned,
}: {
  s: ModelUpgradeSuggestion
  onActioned: (slot: ModelSlot) => void
}) {
  const autoUpdatable = s.overrideRefCount + s.stepRefCount
  const [updateJigs, setUpdateJigs] = useState(autoUpdatable > 0)
  const [working, setWorking] = useState<"approve" | "dismiss" | null>(null)

  async function handleApprove() {
    setWorking("approve")
    try {
      const res = await applyModelUpgrade({
        slot: s.slot,
        modelId: s.suggested.id,
        updateJigs,
      })
      toast.success(
        res.jigsUpdated > 0
          ? `${SLOT_META[s.slot].label} → ${s.suggested.id} (${res.jigsUpdated} jig${res.jigsUpdated === 1 ? "" : "s"} updated)`
          : `${SLOT_META[s.slot].label} → ${s.suggested.id}`,
      )
      void mutate("/api/models")
      void mutate("/api/jigs")
      onActioned(s.slot)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to apply upgrade")
      setWorking(null)
    }
  }

  async function handleDismiss() {
    setWorking("dismiss")
    try {
      await dismissModelUpgrade({ slot: s.slot, modelId: s.suggested.id })
      onActioned(s.slot)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to dismiss")
      setWorking(null)
    }
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {SLOT_META[s.slot].label} model
        </span>
        <span className="text-[10px] text-emerald-400">{s.reason}</span>
      </div>

      <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-start gap-3">
        <div>
          <div className="mb-1 text-[10px] uppercase text-[var(--text-muted)]">Current</div>
          <div className="mb-1 truncate font-mono text-[11px] text-[var(--text-primary)]">{s.current.id}</div>
          <ModelStats model={s.current} />
        </div>
        <div className="mt-5 text-[var(--text-muted)]">→</div>
        <div>
          <div className="mb-1 text-[10px] uppercase text-emerald-400">Suggested</div>
          <div className="mb-1 truncate font-mono text-[11px] text-emerald-200">{s.suggested.id}</div>
          <ModelStats model={s.suggested} />
        </div>
      </div>

      {(autoUpdatable > 0 || s.codeRefCount > 0) && (
        <div className="mb-3 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
          {autoUpdatable > 0 && (
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={updateJigs}
                onChange={(e) => setUpdateJigs(e.target.checked)}
                disabled={working !== null}
                className="mt-0.5"
              />
              <span>
                Also update {autoUpdatable} jig{autoUpdatable === 1 ? "" : "s"} that override this model
              </span>
            </label>
          )}
          {s.codeRefCount > 0 && (
            <div className={autoUpdatable > 0 ? "mt-1 pl-6" : ""}>
              {s.codeRefCount} jig{s.codeRefCount === 1 ? "" : "s"} hardcode this model in source — edit manually if you want them changed
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button onClick={handleDismiss} disabled={working !== null} variant="subtle" size="md">
          {working === "dismiss" ? "Dismissing…" : "Not now"}
        </Button>
        <Button onClick={handleApprove} disabled={working !== null} variant="success" size="md">
          {working === "approve" ? "Applying…" : "Upgrade"}
        </Button>
      </div>
    </div>
  )
}

export function ModelUpgradeModal({
  suggestions,
  onClose,
}: {
  suggestions: ModelUpgradeSuggestion[]
  onClose: () => void
}) {
  const [pending, setPending] = useState<ModelUpgradeSuggestion[]>(suggestions)

  // Auto-close once every card has been actioned. Driven by effect so we
  // don't call the parent setter from inside our setState updater.
  useEffect(() => {
    if (pending.length === 0) onClose()
  }, [pending, onClose])

  function onActioned(slot: ModelSlot) {
    setPending((curr) => curr.filter((s) => s.slot !== slot))
  }

  if (pending.length === 0) return null

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-xl border border-[#2a2a2e] bg-[#111113] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: "fade-up 0.15s ease" }}
      >
        <div className="flex items-start justify-between border-b border-[#1f1f23] px-5 py-4">
          <div>
            <h3 className="text-[14px] font-semibold text-[#ededed]">Model upgrades available</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-[#666]">
              Newer models in the same family that look strictly better than what you're on today.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-3 text-[18px] leading-none text-[#666] hover:text-[#ededed]"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4">
          {pending.map((s) => (
            <SuggestionCard key={s.slot} s={s} onActioned={onActioned} />
          ))}
        </div>
      </div>
    </div>
  )
}
