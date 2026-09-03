import type { ModelCatalog } from "../../shared/api.js"
import { getSetting, setSetting } from "../db.js"

export const DEFAULT_MAIN_MODEL = "meta/muse-spark-1.3"
export const DEFAULT_FAST_MODEL = "deepseek/deepseek-v4-flash-0731"
export const DEFAULT_EDITOR_MODEL = "qwen/qwen3.8-flash"

const SETTINGS_KEY = "models"

type ModelOverrides = { main?: string; editor?: string; fast?: string }

function readOverrides(): ModelOverrides {
  return getSetting<ModelOverrides>(SETTINGS_KEY) ?? {}
}

export function getMainModel(): string {
  return readOverrides().main?.trim() || DEFAULT_MAIN_MODEL
}

export function getEditorModel(): string {
  return readOverrides().editor?.trim() || DEFAULT_EDITOR_MODEL
}

export function getFastModel(): string {
  return readOverrides().fast?.trim() || DEFAULT_FAST_MODEL
}

export function setModelOverrides(patch: ModelOverrides): ModelCatalog {
  const current = readOverrides()
  const next: ModelOverrides = { ...current }
  for (const k of ["main", "editor", "fast"] as const) {
    const v = patch[k]
    if (v === undefined) continue
    const trimmed = v.trim()
    if (!trimmed) delete next[k]
    else next[k] = trimmed
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
    editor: toInfo(getEditorModel()),
    fast: toInfo(getFastModel(), true),
    defaults: {
      main: toInfo(DEFAULT_MAIN_MODEL),
      editor: toInfo(DEFAULT_EDITOR_MODEL),
      fast: toInfo(DEFAULT_FAST_MODEL, true),
    },
  }
}
