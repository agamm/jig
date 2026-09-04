import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb } from "../src/db.js"
import { issueToken, verifyToken } from "../src/auth/session.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("session tokens", () => {
  it("accepts a token it issued", () => {
    expect(verifyToken(issueToken())).toBe(true)
  })

  it("treats a malformed signature as unauthorized instead of throwing", () => {
    const malformed = `1.9999999999.${"z".repeat(64)}`
    expect(() => verifyToken(malformed)).not.toThrow()
    expect(verifyToken(malformed)).toBe(false)
  })
})
