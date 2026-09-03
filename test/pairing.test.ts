import { beforeEach, describe, expect, it } from "bun:test"
import { claimPairingCode, getPairingStatus, mintPairingCode, resetPairingCodes } from "../src/auth/pairing.js"

beforeEach(() => resetPairingCodes())

describe("pairing codes", () => {
  it("redeems a fresh code exactly once", () => {
    const { code } = mintPairingCode()
    expect(claimPairingCode(code)).toBe(true)
    // A leaked paste replayed later must find nothing.
    expect(claimPairingCode(code)).toBe(false)
  })

  it("refuses a code that was never minted", () => {
    mintPairingCode()
    expect(claimPairingCode("not-a-real-code")).toBe(false)
  })

  it("refuses anything when none is outstanding", () => {
    expect(claimPairingCode("anything")).toBe(false)
  })

  it("invalidates the previous code when a new one is minted", () => {
    const first = mintPairingCode().code
    const second = mintPairingCode().code
    expect(claimPairingCode(first)).toBe(false)
    expect(claimPairingCode(second)).toBe(true)
  })

  it("mints enough entropy to survive a public claim endpoint", () => {
    const { code, expiresInS } = mintPairingCode()
    expect(code.length).toBeGreaterThanOrEqual(32)
    expect(/^[A-Za-z0-9_-]+$/.test(code)).toBe(true) // url-safe, pasteable
    expect(expiresInS).toBe(600)
  })

  it("reports back to the page that minted the code", () => {
    expect(getPairingStatus()).toEqual({ outstanding: false, claimed: false })
    const { code } = mintPairingCode()
    expect(getPairingStatus()).toEqual({ outstanding: true, claimed: false })
    claimPairingCode(code)
    // The dashboard polls this to turn its panel green.
    expect(getPairingStatus()).toEqual({ outstanding: false, claimed: true })
  })

  it("does not report a stale yes when a new code is minted", () => {
    claimPairingCode(mintPairingCode().code)
    mintPairingCode()
    expect(getPairingStatus().claimed).toBe(false)
  })
})
