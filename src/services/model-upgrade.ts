/**
 * Computes "equivalent but better" model upgrade suggestions for the user's
 * main / editor / fast slots, and applies them on approval.
 *
 * Matching rule (locked in with user): same provider prefix, newer than the
 * current model, AND strictly cheaper or higher OpenRouter rank. Free-tier
 * models will never be upgraded to paid models silently. The main slot also
 * requires `supportsTools` so the agent loop keeps working.
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
import { fetchOpenRouterModels } from "./openrouter-catalog.js"
import {
  getJigRow,
  getStepModelOverrides,
  listJigs,
  setModelOverride,
  setStepModelOverride,
} from "./jig-store.js"
import { introspectJig } from "./introspect-jig.js"

const DISMISSED_KEY = "modelUpgrades"

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

function provider(id: string): string {
  return id.split("/")[0] ?? id
}

function isFree(m: OpenRouterModelInfo): boolean {
  return m.blendedPriceUsdPerM === 0 || m.id.endsWith(":free")
}

function pickBest(
  slot: ModelSlot,
  current: OpenRouterModelInfo,
  all: OpenRouterModelInfo[],
  dismissed: string[],
): OpenRouterModelInfo | null {
  const currentProvider = provider(current.id)
  const candidates = all.filter((m) => {
    if (m.id === current.id) return false
    if (dismissed.includes(m.id)) return false
    if (provider(m.id) !== currentProvider) return false
    if (m.createdAt <= current.createdAt) return false
    // Agent loop runs in the main slot — must support tool-calling.
    if (slot === "main" && !m.supportsTools) return false
    // Never silently upgrade a free model to a paid one.
    if (isFree(current) && !isFree(m)) return false
    const cheaper = m.blendedPriceUsdPerM < current.blendedPriceUsdPerM
    const betterRank = m.rank < current.rank
    return cheaper || betterRank
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
  const suggestions: ModelUpgradeSuggestion[] = picks.map(({ slot, current, suggested }) => ({
    slot,
    current,
    suggested,
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
