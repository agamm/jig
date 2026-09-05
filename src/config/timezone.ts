import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getSetting, setSetting } from "../db.js"
import { PROJECT_ROOT } from "./paths.js"

const DEFAULT_TIME_ZONE = "America/Chicago"
const SETTINGS_KEY = "system"
const DEPLOY_DEFAULTS_PATH = join(PROJECT_ROOT, "src/config/deploy-defaults.generated.json")

export interface SystemSettings {
  timezone: string
}

export function detectRuntimeTimeZone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return isValidTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function normalizeTimeZone(value: unknown): string {
  if (!isValidTimeZone(value)) {
    throw new Error("Invalid timezone. Use an IANA timezone like America/Chicago.")
  }
  return value.trim()
}

function readDeployDefaultTimeZone(): string | null {
  if (!existsSync(DEPLOY_DEFAULTS_PATH)) return null
  try {
    const parsed = JSON.parse(readFileSync(DEPLOY_DEFAULTS_PATH, "utf8")) as { timezone?: unknown }
    return isValidTimeZone(parsed.timezone) ? parsed.timezone.trim() : null
  } catch {
    return null
  }
}

function defaultSystemTimeZone(): string {
  // Image deploys cannot ship the generated file, so the deployer passes a variable instead.
  const fromEnv = process.env.JIG_TIMEZONE
  if (isValidTimeZone(fromEnv)) return fromEnv.trim()
  return readDeployDefaultTimeZone() ?? detectRuntimeTimeZone()
}

export function getSystemSettings(): SystemSettings {
  const saved = getSetting<Partial<SystemSettings>>(SETTINGS_KEY)
  return {
    timezone: isValidTimeZone(saved?.timezone) ? saved.timezone.trim() : defaultSystemTimeZone(),
  }
}

export function saveSystemSettings(input: Partial<SystemSettings>): SystemSettings {
  const next: SystemSettings = {
    timezone: normalizeTimeZone(input.timezone),
  }
  setSetting(SETTINGS_KEY, next)
  return next
}

export function seedSystemSettingsDefaults(): SystemSettings {
  const saved = getSetting<Partial<SystemSettings>>(SETTINGS_KEY)
  if (isValidTimeZone(saved?.timezone)) return { timezone: saved.timezone.trim() }
  const next = { timezone: defaultSystemTimeZone() }
  setSetting(SETTINGS_KEY, next)
  return next
}

export async function writeDeployDefaults(): Promise<SystemSettings> {
  const defaults = { timezone: detectRuntimeTimeZone() }
  mkdirSync(dirname(DEPLOY_DEFAULTS_PATH), { recursive: true })
  await Bun.write(DEPLOY_DEFAULTS_PATH, `${JSON.stringify(defaults, null, 2)}\n`)
  return defaults
}

export function schedulerTimeZone(): string {
  return getSystemSettings().timezone
}
