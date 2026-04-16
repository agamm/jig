import { join, dirname } from "path"
import { fileURLToPath } from "url"

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")
export const JIGS_DIR = join(PROJECT_ROOT, "jigs")
export const DRAFT_JIGS_DIR = join(JIGS_DIR, "drafts")
export const EXAMPLES_DIR = join(PROJECT_ROOT, "examples")
export const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")
export const TYPES_DIR = join(PROJECT_ROOT, ".jig/types")
export const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")
export const CUSTOM_SERVERS_PATH = join(PROJECT_ROOT, ".jig/custom-servers.json")
export const DASHBOARD_DIR = join(PROJECT_ROOT, "dashboard")
