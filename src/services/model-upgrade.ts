/**
 * Computes "equivalent but better" model upgrade suggestions for the user's
 * main / editor / fast slots, and applies them on approval.
 *
 * Matching rule: a higher OpenRouter rank than the current model, at no more
 * than +20% of its blended price (cross-provider allowed — the best model in
 * your price band often isn't the same family). Free-tier models are never
 * upgraded to paid ones silently. The agentic main/editor slots also require
 * `supportsTools` so the agent loop keeps working.
 *
 * Dismissals are persisted in a single settings row so a suggestion the user
 * said "no" to once doesn't keep nagging them on every dashboard open.
 */
import {
  MODEL_SLOTS,
  type ApplyModelUpgradeResponse,
  type ModelSlot,
  type ModelUpgradeSuggestion,
  type ModelUpgradesResponse,
  type OpenRouterModelInfo,
} from "../../shared/api.js"
import { getSetting, setSetting } from "../db.js"
import {
  getEditorModel,
  getFastModel,
  getMainModel,
  setModelOverrides,
} from "../config/models.js"
import { fetchModelPerf, fetchOpenRouterModels } from "./openrouter-catalog.js"
import {
  getJigRow,
  getStepModelOverrides,
  listJigs,
  setModelOverride,
  setStepModelOverride,
} from "./jig-store.js"
import { introspectJig } from "./introspect-jig.js"

const DISMISSED_KEY = "modelUpgrades"

// A suggestion may cost at most this factor more than the current model.
// Beyond it, a "better rank" model is a price tradeoff, not an upgrade.
const MAX_PRICE_INCREASE = 1.2

type DismissedMap = Partial<Record<ModelSlot, string[]>>

function getSlotModel(slot: ModelSlot): string {
  switch (slot) {
    case "main": return getMainModel()
    case "editor": return getEditorModel()
    case "fast": return getFastModel()
  }
}

function readDismissed(): DismissedMap {
  return getSetting<DismissedMap>(DISMISSED_KEY) ?? {}
}

/**
 * OpenRouter variant suffixes that change how a call is delivered, not just how
 * well it performs. `:batch` is an async queue with turnaround measured in
 * hours, so it is cheaper and often better ranked and therefore looks like a
 * pure win to the ranker — but a jig awaiting one would hang past its run
 * timeout. Never offer these as a drop-in upgrade for a synchronous slot.
 */
const NON_INTERACTIVE_VARIANTS = [":batch"]

function isNonInteractiveVariant(m: OpenRouterModelInfo): boolean {
  return NON_INTERACTIVE_VARIANTS.some((suffix) => m.id.endsWith(suffix))
}

function isFree(m: OpenRouterModelInfo): boolean {
  return m.blendedPriceUsdPerM === 0 || m.id.endsWith(":free")
}

export function pickBest(
  slot: ModelSlot,
  current: OpenRouterModelInfo,
  all: OpenRouterModelInfo[],
  dismissed: string[],
): OpenRouterModelInfo | null {
  const candidates = all.filter((m) => {
    if (m.id === current.id) return false
    if (dismissed.includes(m.id)) return false
    if (isNonInteractiveVariant(m)) return false
    // Agentic slots run tool-calling loops — a non-tool model would break them.
    if ((slot === "main" || slot === "editor") && !m.supportsTools) return false
    // Never silently move a free model to a paid one (keeps the fast/free slot free).
    if (isFree(current) && !isFree(m)) return false
    // Stay within the cost cap: cheaper, or at most +20% pricier. A better-ranked
    // but far pricier model (haiku-4.5 $4/M → fable-5 $40/M, +900%) is a tradeoff,
    // not an upgrade.
    if (m.blendedPriceUsdPerM > current.blendedPriceUsdPerM * MAX_PRICE_INCREASE) return false
    // "Better" = higher OpenRouter rank. Cross-provider is allowed — the best
    // model within your price often isn't from the same family (e.g. a cheap,
    // low-ranked model has no same-provider upgrade under the price cap, but
    // plenty of better-ranked options exist elsewhere).
    return m.rank < current.rank
  })
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.blendedPriceUsdPerM - b.blendedPriceUsdPerM
  })
  return candidates[0]
}

function reasonString(current: OpenRouterModelInfo, suggested: OpenRouterModelInfo): string {
  const parts: string[] = []
  if (suggested.createdAt > current.createdAt) parts.push("newer")
  if (current.blendedPriceUsdPerM > 0 && suggested.blendedPriceUsdPerM < current.blendedPriceUsdPerM) {
    const pct = Math.round((1 - suggested.blendedPriceUsdPerM / current.blendedPriceUsdPerM) * 100)
    if (pct > 0) parts.push(`${pct}% cheaper`)
  } else if (current.blendedPriceUsdPerM === 0 && suggested.blendedPriceUsdPerM === 0) {
    parts.push("free tier")
  }
  if (suggested.rank < current.rank) {
    // OpenRouter ranks are 0-indexed in our catalog; show 1-indexed to humans.
    parts.push(`rank #${suggested.rank + 1} (was #${current.rank + 1})`)
  }
  return parts.join(" • ")
}

type SlotCounts = { override: number; step: number; code: number }

/**
 * Scan all jigs once, returning per-slot reference counts keyed by the
 * current model id of each slot. Single jig pass + parallel introspection
 * — avoids the original 3×listJigs × N×introspect blowup.
 */
async function countRefsForAllSlots(
  currentBySlot: Record<ModelSlot, string>,
): Promise<Record<ModelSlot, SlotCounts>> {
  const counts: Record<ModelSlot, SlotCounts> = {
    main: { override: 0, step: 0, code: 0 },
    editor: { override: 0, step: 0, code: 0 },
    fast: { override: 0, step: 0, code: 0 },
  }
  const summaries = listJigs()
  // Source parsing is the slow part — fan out, swallow per-jig failures so
  // one broken jig doesn't blank the whole count.
  const introspections = await Promise.all(
    summaries.map((s) => introspectJig(s.id, { includeSteps: false }).catch(() => null)),
  )
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i]
    const row = getJigRow(s.id)
    const steps = getStepModelOverrides(s.id)
    const inCode = introspections[i]?.modelInCode ?? null
    for (const slot of MODEL_SLOTS) {
      const target = currentBySlot[slot]
      if (row?.model_override === target) counts[slot].override++
      if (Object.values(steps).some((m) => m === target)) counts[slot].step++
      if (inCode === target) counts[slot].code++
    }
  }
  return counts
}

export async function computeUpgradeSuggestions(): Promise<ModelUpgradesResponse> {
  const { models, fetchedAt } = await fetchOpenRouterModels()
  const byId = new Map(models.map((m) => [m.id, m]))
  const dismissed = readDismissed()

  // Resolve current models per slot, then pick suggestions. Only scan jigs
  // for slots that actually have a suggestion — cheaper when nothing's new.
  const currentBySlot: Record<ModelSlot, string> = {
    main: getSlotModel("main"),
    editor: getSlotModel("editor"),
    fast: getSlotModel("fast"),
  }

  const picks: Array<{ slot: ModelSlot; current: OpenRouterModelInfo; suggested: OpenRouterModelInfo }> = []
  for (const slot of MODEL_SLOTS) {
    const current = byId.get(currentBySlot[slot])
    if (!current) continue
    const suggested = pickBest(slot, current, models, dismissed[slot] ?? [])
    if (!suggested) continue
    picks.push({ slot, current, suggested })
  }
  if (picks.length === 0) return { suggestions: [], fetchedAt }

  const counts = await countRefsForAllSlots(currentBySlot)

  // Enrich only the models actually shown (current + suggested per pick) with
  // latency/throughput — these aren't in the bulk /models list. Dedup by id so
  // a model used in two slots is fetched once.
  const perfIds = new Set<string>()
  for (const p of picks) { perfIds.add(p.current.id); perfIds.add(p.suggested.id) }
  const perfById = new Map<string, Awaited<ReturnType<typeof fetchModelPerf>>>()
  await Promise.all(
    [...perfIds].map(async (id) => { perfById.set(id, await fetchModelPerf(id)) }),
  )
  const withPerf = (m: OpenRouterModelInfo): OpenRouterModelInfo => {
    const perf = perfById.get(m.id)
    return perf ? { ...m, latencyMs: perf.latencyMs, throughputTps: perf.throughputTps } : m
  }

  const suggestions: ModelUpgradeSuggestion[] = picks.map(({ slot, current, suggested }) => ({
    slot,
    current: withPerf(current),
    suggested: withPerf(suggested),
    reason: reasonString(current, suggested),
    overrideRefCount: counts[slot].override,
    stepRefCount: counts[slot].step,
    codeRefCount: counts[slot].code,
  }))

  return { suggestions, fetchedAt }
}

export function applyUpgrade(
  slot: ModelSlot,
  modelId: string,
  updateJigs: boolean,
): ApplyModelUpgradeResponse {
  const previousId = getSlotModel(slot)
  setModelOverrides({ [slot]: modelId })

  let jigsUpdated = 0
  if (updateJigs && previousId !== modelId) {
    for (const s of listJigs()) {
      let touched = false
      const row = getJigRow(s.id)
      if (row?.model_override === previousId) {
        setModelOverride(s.id, modelId)
        touched = true
      }
      const steps = getStepModelOverrides(s.id)
      for (const [seqStr, m] of Object.entries(steps)) {
        if (m === previousId) {
          const seq = Number(seqStr)
          if (Number.isInteger(seq) && seq > 0) {
            setStepModelOverride(s.id, seq, modelId)
            touched = true
          }
        }
      }
      if (touched) jigsUpdated++
    }
  }

  return { ok: true, slot, modelId, jigsUpdated }
}

export function dismissUpgrade(slot: ModelSlot, modelId: string): void {
  const current = readDismissed()
  const list = current[slot] ?? []
  if (!list.includes(modelId)) {
    current[slot] = [...list, modelId]
    setSetting(DISMISSED_KEY, current)
  }
}
