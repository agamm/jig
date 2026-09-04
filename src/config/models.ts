import type { ModelCatalog } from "../../shared/api.js"
import { getSetting, setSetting } from "../db.js"

export const DEFAULT_MAIN_MODEL = "meta/muse-spark-1.3"
export const DEFAULT_FAST_MODEL = "deepseek/deepseek-v4-flash-0731"

const SETTINGS_KEY = "models"

type ModelOverrides = { main?: string; fast?: string }

function readOverrides(): ModelOverrides {
  return getSetting<ModelOverrides>(SETTINGS_KEY) ?? {}
}

export function getMainModel(): string {
  return readOverrides().main?.trim() || DEFAULT_MAIN_MODEL
}

export function getFastModel(): string {
  return readOverrides().fast?.trim() || DEFAULT_FAST_MODEL
}

export function setModelOverrides(patch: ModelOverrides): ModelCatalog {
  const current = readOverrides()
  // Rebuilt from the known slots only, so a key left by a removed slot is dropped on save.
  const next: ModelOverrides = {}
  for (const k of ["main", "fast"] as const) {
    const v = patch[k] === undefined ? current[k] : patch[k]
    const trimmed = v?.trim()
    if (trimmed) next[k] = trimmed
  }
  setSetting(SETTINGS_KEY, next)
  return getModelCatalog()
}

function toInfo(id: string, stripTag = false): { id: string; label: string } {
  const tail = id.split("/").pop()!
  return { id, label: stripTag ? tail.replace(/:.*/, "") : tail }
}

export function getModelCatalog(): ModelCatalog {
  return {
    main: toInfo(getMainModel()),
    fast: toInfo(getFastModel(), true),
    defaults: {
      main: toInfo(DEFAULT_MAIN_MODEL),
      fast: toInfo(DEFAULT_FAST_MODEL, true),
    },
  }
}
