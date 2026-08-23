/**
 * ctx.memory, the cross-run store a jig remembers things in.
 *
 * Every other piece of jig state is derived: params come from the trigger,
 * outputs are per-run, and the run history is a log, not a datastore. Without
 * this a jig cannot know anything its own last run learned, which is why
 * "remember this and act on it later" was previously impossible to write.
 *
 * Values round-trip as JSON. Keys are opaque strings; a jig that wants records
 * rather than singletons should namespace them ("todo:<id>") and read them back
 * with list("todo:").
 */
import { isDryRun } from "./dryrun.js"

export interface JigMemory {
  /** The stored value, or null when the key was never written. */
  get<T = unknown>(key: string): Promise<T | null>
  /** Write (or overwrite) a key. No-ops during a dry run. */
  set(key: string, value: unknown): Promise<void>
  /** True when a key was actually removed. No-ops during a dry run. */
  delete(key: string): Promise<boolean>
  /** Every key, or just those starting with `prefix`, in key order. */
  list<T = unknown>(prefix?: string): Promise<{ key: string; value: T }[]>
}

/** Longest key the SDK accepts. Keys identify a record; data goes in the value. */
export const MEMORY_MAX_KEY_LENGTH = 200

function assertKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("ctx.memory keys must be a non-empty string")
  }
  if (key.length > MEMORY_MAX_KEY_LENGTH) {
    throw new Error(
      `ctx.memory key is ${key.length} characters, over the ${MEMORY_MAX_KEY_LENGTH} limit. ` +
      `Keys identify a record; put the data in the value.`
    )
  }
}

/**
 * Build the memory API for one jig. `jigId` is required: memory is scoped per
 * jig, so a context with no jig identity has nowhere to put it, and silently
 * discarding writes would look like data loss at the next run.
 */
export function createJigMemory(jigId: string | undefined, onDryRunWrite: (message: string) => void): JigMemory {
  function requireJigId(): string {
    if (!jigId) {
      throw new Error(
        "ctx.memory needs a jig identity and this run has none. " +
        "Run the jig by id (jig run <jig-id>, or from the dashboard) rather than by file path."
      )
    }
    return jigId
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      assertKey(key)
      const { getJigMemory } = await import("../db.js")
      const raw = getJigMemory(requireJigId(), key)
      if (raw == null) return null
      try {
        return JSON.parse(raw) as T
      } catch {
        // A value written outside the SDK (dashboard edit, manual repair) may
        // not be JSON. Hand back the raw string rather than throwing, so one
        // bad row cannot break every run that reads near it.
        return raw as unknown as T
      }
    },

    async set(key: string, value: unknown): Promise<void> {
      assertKey(key)
      const id = requireJigId()
      const encoded = JSON.stringify(value ?? null)
      if (encoded === undefined) {
        throw new Error(`ctx.memory.set("${key}") value is not JSON-serializable`)
      }
      const { MEMORY_MAX_VALUE_BYTES, MEMORY_MAX_KEYS_PER_JIG, setJigMemory } = await import("../db.js")
      const bytes = Buffer.byteLength(encoded, "utf8")
      if (bytes > MEMORY_MAX_VALUE_BYTES) {
        throw new Error(
          `ctx.memory.set("${key}") value is ${bytes} bytes, over the ${MEMORY_MAX_VALUE_BYTES} limit. ` +
          `Store a reference or a summary rather than the whole payload.`
        )
      }
      if (isDryRun()) {
        onDryRunWrite(`[dry-run] would remember ${key} (${bytes} bytes)`)
        return
      }
      if (!setJigMemory(id, key, encoded)) {
        throw new Error(
          `ctx.memory is full for this jig (${MEMORY_MAX_KEYS_PER_JIG} keys). ` +
          `Delete keys the jig no longer needs, a jig that writes a new key every run will always hit this.`
        )
      }
    },

    async delete(key: string): Promise<boolean> {
      assertKey(key)
      const id = requireJigId()
      if (isDryRun()) {
        onDryRunWrite(`[dry-run] would forget ${key}`)
        return false
      }
      const { deleteJigMemory } = await import("../db.js")
      return deleteJigMemory(id, key)
    },

    async list<T = unknown>(prefix?: string): Promise<{ key: string; value: T }[]> {
      const { listJigMemory } = await import("../db.js")
      return listJigMemory(requireJigId(), prefix).map((row) => {
        let value: unknown
        try {
          value = JSON.parse(row.value)
        } catch {
          value = row.value
        }
        return { key: row.key, value: value as T }
      })
    },
  }
}
