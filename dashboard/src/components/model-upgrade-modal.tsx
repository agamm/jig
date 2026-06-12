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

function latencyLabel(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/**
 * Compact one-line spec: price first (the figure that actually changes a
 * decision), then context and capability flags. `priceTone` lets the
 * suggested side flag a cost increase so "upgrade" doesn't hide a 10× bill.
 */
function ModelStats({ model, priceTone }: { model: OpenRouterModelInfo; priceTone?: "up" | "down" | "same" }) {
  const priceClass =
    priceTone === "up" ? "text-amber-400" : priceTone === "down" ? "text-emerald-400" : "text-[var(--text-secondary)]"
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-[var(--text-muted)]">
      <span className={`font-medium ${priceClass}`}>
        {priceLabel(model.blendedPriceUsdPerM)}
        {priceTone === "up" ? " ↑" : priceTone === "down" ? " ↓" : ""}
      </span>
      <span className="opacity-40">·</span>
      <span>{fmtContext(model.contextLength)}</span>
      {typeof model.latencyMs === "number" && (
        <>
          <span className="opacity-40">·</span>
          <span title="p50 time to first token">{latencyLabel(model.latencyMs)}</span>
        </>
      )}
      {typeof model.throughputTps === "number" && (
        <>
          <span className="opacity-40">·</span>
          <span title="p50 output throughput">{Math.round(model.throughputTps)} tok/s</span>
        </>
      )}
      {model.supportsTools && <span className="opacity-40">·</span>}
      {model.supportsTools && <span>tools</span>}
      {model.supportsReasoning && <span className="opacity-40">·</span>}
      {model.supportsReasoning && <span>reasoning</span>}
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

  // Compare blended cost so the suggested side can flag a price jump.
  const priceTone: "up" | "down" | "same" =
    s.suggested.blendedPriceUsdPerM > s.current.blendedPriceUsdPerM
      ? "up"
      : s.suggested.blendedPriceUsdPerM < s.current.blendedPriceUsdPerM
        ? "down"
        : "same"

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {SLOT_META[s.slot].label}
        </span>
        <span className="truncate text-[10px] text-emerald-400">{s.reason}</span>
      </div>

      {/* min-w-0 on each column lets `truncate` actually shrink the id —
          without it the grid track grows to the id width and overflows. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]" title={s.current.id}>{s.current.id}</div>
          <ModelStats model={s.current} />
        </div>
        <div className="shrink-0 text-[var(--text-muted)]">→</div>
        <div className="min-w-0">
          <div className="truncate font-mono text-[11px] text-emerald-200" title={s.suggested.id}>{s.suggested.id}</div>
          <ModelStats model={s.suggested} priceTone={priceTone} />
        </div>
      </div>

      {(autoUpdatable > 0 || s.codeRefCount > 0) && (
        <div className="mt-2.5 rounded border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-[10px] text-[var(--text-muted)]">
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
              {s.codeRefCount} jig{s.codeRefCount === 1 ? "" : "s"} hardcode this model in source — edit manually
            </div>
          )}
        </div>
      )}

      <div className="mt-2.5 flex justify-end gap-2">
        <Button onClick={handleDismiss} disabled={working !== null} variant="subtle" size="sm">
          {working === "dismiss" ? "Dismissing…" : "Not now"}
        </Button>
        <Button onClick={handleApprove} disabled={working !== null} variant="success" size="sm">
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
              Higher-ranked models at a similar or lower price — any provider. Check the stats before upgrading.
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
