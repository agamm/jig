/**
 * Local log reader — reads the `logs` table straight off the volume instead of
 * going through the HTTP API.
 *
 * Why this exists: the API's admin gate returns 423 while the instance is
 * locked, *before* it checks the session cookie (see auth/lock-middleware.ts).
 * So `jig debug tail` against a locked box fails — exactly when you most need
 * it. Run this inside the container instead:
 *
 *     railway ssh "bun run src/cli.ts debug tail --local"
 *
 * Container access is the authorization: whoever can open a shell can already
 * read this file. Nothing here touches credentials — those stay encrypted and
 * unreadable without the password.
 *
 * The handle is opened read-only, so no schema migration or log-capture side
 * effect can fire from a debugging session.
 */
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { DB_PATH } from "../config/paths.js"
import type { ServerLogEntry } from "../../shared/api.js"

let handle: Database | null = null

function db(): Database {
  if (handle) return handle
  if (!existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}.`)
    console.error(`Set JIG_DATA_DIR if the volume is mounted elsewhere.`)
    process.exit(1)
  }
  handle = new Database(DB_PATH, { readonly: true })
  return handle
}

/** Entries after `sinceSeq`, oldest first. */
export function readLocalLogs(sinceSeq: number): ServerLogEntry[] {
  return db()
    .prepare("SELECT seq, ts, level, source, msg, payload FROM logs WHERE seq > ? ORDER BY seq ASC")
    .all(sinceSeq) as ServerLogEntry[]
}

/** Highest seq present, or 0 when the table is empty. */
export function readLocalLogHead(): number {
  const row = db().prepare("SELECT MAX(seq) AS seq FROM logs").get() as { seq: number | null }
  return row?.seq ?? 0
}
