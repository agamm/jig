/**
 * The instance key: JIG_DATA_KEY wraps the password-derived data key so a
 * restart (deploy, update, crash) does not lock a hosted instance. The
 * password stays the login secret and the only way in without the variable.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, getCredential, openDb, setCredential } from "../src/db.js"
import { collectSnapshot } from "../src/backup/index.js"
import {
  changePassword,
  DATA_KEY_ENV,
  forgetDataKey,
  isUnlocked,
  lock,
  mintDataKey,
  setPassword,
  tryAutoUnlock,
  unlock,
} from "../src/crypto/password.js"

const PASSWORD = "correct horse battery"

function wrappedKeyRow(): string | null {
  const row = openDb().prepare(`SELECT value FROM settings WHERE key = 'key.wrapped'`).get() as { value: string } | undefined
  return row?.value ?? null
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  forgetDataKey()
  delete process.env[DATA_KEY_ENV]
})

afterEach(() => {
  forgetDataKey()
  delete process.env[DATA_KEY_ENV]
  closeDb()
})

describe("mintDataKey", () => {
  it("is 32 random bytes as hex", () => {
    const a = mintDataKey()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(mintDataKey()).not.toBe(a)
  })
})

describe("boot with JIG_DATA_KEY", () => {
  it("setPassword wraps the data key, and the next process unlocks from the wrap alone", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    setCredential("svc:token", "secret-value", "svc")
    expect(wrappedKeyRow()).not.toBeNull()

    forgetDataKey() // what a restart does to memory: the settings row survives
    expect(isUnlocked()).toBe(false)
    expect(tryAutoUnlock()).toBe("unlocked")
    expect(isUnlocked()).toBe(true)
    expect(getCredential("svc:token")).toBe("secret-value")
  })

  it("a password set before the variable existed stays locked until the first unlock, which wraps", () => {
    setPassword(PASSWORD)
    expect(wrappedKeyRow()).toBeNull()

    process.env[DATA_KEY_ENV] = mintDataKey()
    forgetDataKey()
    expect(tryAutoUnlock()).toBe("no-wrapped-key")
    expect(isUnlocked()).toBe(false)

    expect(unlock(PASSWORD)).toBe(true)
    expect(wrappedKeyRow()).not.toBeNull()
    forgetDataKey()
    expect(tryAutoUnlock()).toBe("unlocked")
  })

  it("a wrong password never wraps", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    openDb().prepare(`DELETE FROM settings WHERE key = 'key.wrapped'`).run()
    forgetDataKey()
    expect(unlock("not the password")).toBe(false)
    expect(wrappedKeyRow()).toBeNull()
  })

  it("the wrong JIG_DATA_KEY cannot unlock and does not throw", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    forgetDataKey()
    process.env[DATA_KEY_ENV] = mintDataKey()
    expect(tryAutoUnlock()).toBe("bad-key")
    expect(isUnlocked()).toBe(false)
    // The password still works, and re-wraps under the key this process has.
    expect(unlock(PASSWORD)).toBe(true)
    forgetDataKey()
    expect(tryAutoUnlock()).toBe("unlocked")
  })

  it("without the variable nothing is wrapped and boot stays locked", () => {
    setPassword(PASSWORD)
    expect(wrappedKeyRow()).toBeNull()
    forgetDataKey()
    expect(tryAutoUnlock()).toBe("no-env-key")
    expect(isUnlocked()).toBe(false)
  })

  it("a malformed JIG_DATA_KEY counts as absent", () => {
    process.env[DATA_KEY_ENV] = "definitely-not-64-hex-chars"
    setPassword(PASSWORD)
    expect(wrappedKeyRow()).toBeNull()
    forgetDataKey()
    expect(tryAutoUnlock()).toBe("no-env-key")
  })

  it("already unlocked is reported as unlocked without touching the wrap", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    expect(tryAutoUnlock()).toBe("unlocked")
  })
})

describe("lock and password change", () => {
  it("lock() forgets the wrap, so a deliberate lock survives a restart", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    lock()
    expect(isUnlocked()).toBe(false)
    expect(wrappedKeyRow()).toBeNull()
    expect(tryAutoUnlock()).toBe("no-wrapped-key")
  })

  it("changePassword re-wraps: the new key unlocks at boot and old credentials still decrypt", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    setCredential("svc:token", "secret-value", "svc")
    const before = wrappedKeyRow()

    changePassword("a different passphrase")
    expect(wrappedKeyRow()).not.toBe(before)

    forgetDataKey()
    expect(tryAutoUnlock()).toBe("unlocked")
    expect(getCredential("svc:token")).toBe("secret-value")
    forgetDataKey()
    expect(unlock(PASSWORD)).toBe(false)
    expect(unlock("a different passphrase")).toBe(true)
  })
})

describe("backup", () => {
  it("never carries the wrap: a restored instance still needs its password", () => {
    process.env[DATA_KEY_ENV] = mintDataKey()
    setPassword(PASSWORD)
    expect(wrappedKeyRow()).not.toBeNull()
    expect(Object.keys(collectSnapshot().settings)).not.toContain("key.wrapped")
  })
})
