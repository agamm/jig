/**
 * Jig file validator — checks that jig files export a valid JigDefinition.
 *
 * Used by the creator pipeline after generating/editing jigs,
 * and can be run standalone: bun run src/validate.ts jigs/weekly-update.ts
 */
import { existsSync } from "fs"
import type { JigDefinition, JigTrigger } from "./sdk/jig.js"
import { PROJECT_ROOT } from "./config/paths.js"

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  definition?: JigDefinition
}

// ---------------------------------------------------------------------------
// Trigger validation
// ---------------------------------------------------------------------------

const CRON_REGEX = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/

function validateTrigger(trigger: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  if (trigger === undefined) {
    return [{ field: "trigger", message: 'Trigger is required. Use { type: "manual" } for manually-triggered jigs.' }]
  }

  if (typeof trigger !== "object" || trigger === null || !("type" in trigger)) {
    errors.push({ field: "trigger", message: "Trigger must be an object with a 'type' field" })
    return errors
  }

  const t = trigger as Record<string, unknown>
  switch (t.type) {
    case "cron":
      if (typeof t.cron !== "string") {
        errors.push({ field: "trigger.cron", message: "Cron trigger requires a 'cron' string" })
      } else if (!CRON_REGEX.test(t.cron.trim())) {
        errors.push({ field: "trigger.cron", message: `Invalid cron expression: "${t.cron}". Expected 5 fields: minute hour day month weekday` })
      }
      break
    case "interval":
      if (typeof t.minutes !== "number" || t.minutes <= 0) {
        errors.push({ field: "trigger.minutes", message: "Interval trigger requires a positive 'minutes' number" })
      }
      break
    case "event":
      if (typeof t.source !== "string" || !t.source) {
        errors.push({ field: "trigger.source", message: "Event trigger requires a 'source' string" })
      }
      break
    case "manual":
    case "webhook":
      break // no additional fields required
    default:
      errors.push({ field: "trigger.type", message: `Unknown trigger type: "${t.type}". Expected: cron, interval, event, manual, webhook` })
  }
  return errors
}

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

function validateDefinition(def: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (typeof def !== "object" || def === null) {
    errors.push({ field: "default", message: "Default export must be an object (JigDefinition)" })
    return errors
  }

  const d = def as Record<string, unknown>

  // name
  if (typeof d.name !== "string" || !d.name) {
    errors.push({ field: "name", message: "Jig must have a non-empty 'name' string" })
  }

  // options
  if (typeof d.options !== "object" || d.options === null) {
    errors.push({ field: "options", message: "Jig must have an 'options' object" })
  } else {
    const opts = d.options as Record<string, unknown>

    // trigger
    errors.push(...validateTrigger(opts.trigger))

    // tools
    if (opts.tools !== undefined) {
      if (!Array.isArray(opts.tools)) {
        errors.push({ field: "options.tools", message: "Tools must be an array" })
      }
    }

    // params
    if (opts.params !== undefined) {
      if (typeof opts.params !== "object" || opts.params === null) {
        errors.push({ field: "options.params", message: "Params must be a Record<string, string>" })
      }
    }
  }

  // handler
  if (typeof d.handler !== "function") {
    errors.push({ field: "handler", message: "Jig must have a 'handler' function" })
  }

  return errors
}

// ---------------------------------------------------------------------------
// File validation (import + check)
// ---------------------------------------------------------------------------

/**
 * Validate a jig file by importing it and checking its default export.
 * Returns validation result with errors (if any) and the definition.
 */
export async function validateJigFile(path: string): Promise<ValidationResult> {
  if (!existsSync(path)) {
    return { ok: false, errors: [{ field: "file", message: `File not found: ${path}` }] }
  }

  try {
    const mod = await import(`${path}?_t=${Date.now()}`)
    if (!mod.default) {
      return { ok: false, errors: [{ field: "default", message: "Jig file must have a default export" }] }
    }

    const errors = validateDefinition(mod.default)
    return {
      ok: errors.length === 0,
      errors,
      definition: errors.length === 0 ? mod.default : undefined,
    }
  } catch (e: any) {
    return {
      ok: false,
      errors: [{ field: "import", message: `Failed to import jig: ${e?.message ?? String(e)}` }],
    }
  }
}

/**
 * Validate a JigDefinition object directly (without importing a file).
 * Used after code generation to check the definition before writing to disk.
 */
export function validateDefinitionObject(def: unknown): ValidationResult {
  const errors = validateDefinition(def)
  return {
    ok: errors.length === 0,
    errors,
    definition: errors.length === 0 ? def as JigDefinition : undefined,
  }
}

// ---------------------------------------------------------------------------
// CLI: bun run src/validate.ts <path>
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: bun run src/validate.ts <jig-file.ts>")
    process.exit(1)
  }

  const absPath = path.startsWith("/") ? path : `${PROJECT_ROOT}/${path}`
  const result = await validateJigFile(absPath)

  if (result.ok) {
    console.log(`✓ ${path} is valid`)
    if (result.definition) {
      const trigger = result.definition.options.trigger
      console.log(`  name: ${result.definition.name}`)
      console.log(`  trigger: ${trigger ? `${trigger.type}${trigger.type === "cron" ? ` (${trigger.cron})` : ""}` : "none"}`)
      console.log(`  tools: ${(result.definition.options.tools ?? []).length}`)
    }
  } else {
    console.error(`✗ ${path} has errors:`)
    for (const e of result.errors) {
      console.error(`  ${e.field}: ${e.message}`)
    }
    process.exit(1)
  }
}
