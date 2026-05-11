import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { isServiceMode } from "./runtime.js"

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

/**
 * Mutable data lives here. Split from code so updates never clobber user state.
 * - Service mode: `/data` (Railway volume mount). Caller is responsible for
 *   ensuring the volume is mounted there.
 * - Local mode: PROJECT_ROOT (preserves existing developer layout).
 */
export const DATA_DIR = isServiceMode() ? "/data" : PROJECT_ROOT

/**
 * MCP-generated metadata (schemas, typegen, custom server list). Local keeps
 * the `.jig/` dotdir to avoid regressing existing dev checkouts; service mode
 * gets a flat layout under the volume.
 */
const META_DIR = isServiceMode() ? DATA_DIR : join(PROJECT_ROOT, ".jig")

export const DB_PATH = join(DATA_DIR, "jig.db")
export const JIGS_DIR = join(DATA_DIR, "jigs")
export const DRAFT_JIGS_DIR = join(JIGS_DIR, "drafts")
/** Materialized active-version code, written on demand for Bun.import. Path includes versionId so module cache stays correct. */
export const RUNTIME_DIR = join(DATA_DIR, "runtime")
/** Transient typecheck files for pending code. Wiped between checks. */
export const CHECK_DIR = join(DATA_DIR, "check")
export const SCHEMAS_DIR = join(META_DIR, "schemas")
export const TYPES_DIR = join(META_DIR, "types")
export const CONNECTIONS_DIR = join(META_DIR, "connections")
export const CUSTOM_SERVERS_PATH = join(META_DIR, "custom-servers.json")
export const NOTIFICATION_TOOLS_PATH = join(META_DIR, "notification-tools.json")

/** Read-only code assets — always resolve from the git checkout. */
export const EXAMPLES_DIR = join(PROJECT_ROOT, "examples")
export const DASHBOARD_DIR = join(PROJECT_ROOT, "dashboard")
