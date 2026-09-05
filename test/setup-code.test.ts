import { afterEach, describe, expect, it } from "bun:test"
import {
  claimSetupCodePairing,
  clearSetupCode,
  formatSetupCode,
  getSetupCode,
  mintSetupCode,
  resetSetupCodeState,
  verifySetupCode,
} from "../src/auth/setup-code.js"

const envBefore = process.env.JIG_SETUP_CODE
afterEach(() => {
  resetSetupCodeState()
  if (envBefore === undefined) delete process.env.JIG_SETUP_CODE
  else process.env.JIG_SETUP_CODE = envBefore
})

describe("setup code", () => {
  it("uses the code the deployer passed in, in any spelling", () => {
    process.env.JIG_SETUP_CODE = "abcd efgh jkmn"
    expect(getSetupCode()).toBe("ABCD-EFGH-JKMN")
    expect(verifySetupCode("abcdefghjkmn")).toBe(true)
    expect(verifySetupCode("ABCD-EFGH-JKMX")).toBe(false)
  })

  it("mints its own when the variable is missing or malformed", () => {
    process.env.JIG_SETUP_CODE = "not-a-code"
    const code = getSetupCode()
    expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/)
    expect(code).not.toBe("NOTA-CODE")
    expect(mintSetupCode()).not.toBe(code)
    expect(formatSetupCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN")
  })

  it("pairs one CLI session with the retired code after the password is set, then never again", () => {
    process.env.JIG_SETUP_CODE = "ABCD-EFGH-JKMN"
    getSetupCode()
    // Before the password exists the code is for claiming, not pairing.
    expect(claimSetupCodePairing("ABCD-EFGH-JKMN")).toBe(false)
    clearSetupCode()
    expect(verifySetupCode("ABCD-EFGH-JKMN")).toBe(false)
    expect(claimSetupCodePairing("abcd-efgh-jkmn")).toBe(true)
    expect(claimSetupCodePairing("ABCD-EFGH-JKMN")).toBe(false)
  })
})
