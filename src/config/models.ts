import type { ModelsDto } from "../../shared/api.js"

export const MAIN_MODEL = "anthropic/claude-haiku-4.5"
export const TRIGGER_PARSE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"
export const JIG_EDITOR_MODEL = "deepseek/deepseek-v3.2"
export const HUMANIZE_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

export function getModelCatalog(): ModelsDto {
  return {
    main: { id: MAIN_MODEL, label: MAIN_MODEL.split("/").pop()! },
    editor: { id: JIG_EDITOR_MODEL, label: JIG_EDITOR_MODEL.split("/").pop()! },
    fast: { id: TRIGGER_PARSE_MODEL, label: TRIGGER_PARSE_MODEL.split("/").pop()!.replace(/:.*/, "") },
  }
}
