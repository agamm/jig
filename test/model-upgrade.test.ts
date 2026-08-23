import { describe, expect, it } from "bun:test"
import { isFoundationalProvider, pickBest, providerOf } from "../src/services/model-upgrade.js"
import type { OpenRouterModelInfo } from "../src/services/openrouter-catalog.js"

const JAN = 1_700_000_000
const LATER = JAN + 90 * 24 * 60 * 60

const model = (over: Partial<OpenRouterModelInfo> & { id: string }): OpenRouterModelInfo => ({
  name: over.id,
  contextLength: 1_000_000,
  promptPriceUsdPerM: 1,
  completionPriceUsdPerM: 1,
  blendedPriceUsdPerM: 1,
  supportsTools: true,
  supportsReasoning: true,
  supportsImages: false,
  createdAt: JAN,
  catalogOrder: 40,
  ...over,
})

const current = model({ id: "openai/gpt-5.6-luna-pro", blendedPriceUsdPerM: 1, createdAt: JAN })

describe("pickBest", () => {
  // A :batch model is cheaper and ships beside its parent, so it looked like a
  // pure win and got suggested. It is an async queue endpoint, not a drop-in
  // for a synchronous call: a jig awaiting one would hang past its run timeout.
  it("never suggests a :batch variant", () => {
    const batch = model({ id: "google/gemini-3.7-flash:batch", blendedPriceUsdPerM: 0.75, createdAt: LATER })
    expect(pickBest("main", current, [current, batch], [])).toBeNull()
  })

  it("still suggests the non-batch model of the same family", () => {
    const batch = model({ id: "google/gemini-3.7-flash:batch", blendedPriceUsdPerM: 0.75, createdAt: LATER })
    const plain = model({ id: "google/gemini-3.7-flash", blendedPriceUsdPerM: 0.9, createdAt: LATER })
    expect(pickBest("main", current, [current, batch, plain], [])?.id).toBe("google/gemini-3.7-flash")
  })

  // Same intent as before the provider allowlist landed: the ":batch" rule must
  // match the suffix, not the substring. Vendor changed to an allowlisted one
  // so the case still reaches that rule.
  it("does not reject a model that merely has batch in its name", () => {
    const ok = model({ id: "mistralai/batcher-1", blendedPriceUsdPerM: 0.5, createdAt: LATER })
    expect(pickBest("main", current, [current, ok], [])?.id).toBe("mistralai/batcher-1")
  })

  // OpenRouter lists /models newest-first and publishes no popularity figure,
  // so a brand-new listing from an unknown vendor used to outrank everything.
  it("never suggests a model from outside the foundational allowlist", () => {
    const obscure = model({ id: "dots-studio/dots-3-note-preview", blendedPriceUsdPerM: 0.2, createdAt: LATER })
    const alsoObscure = model({ id: "tencent/hy-mt2-1.8b", blendedPriceUsdPerM: 0.1, createdAt: LATER })

    expect(pickBest("main", current, [current, obscure, alsoObscure], [])).toBeNull()
  })

  it("prefers a known lab over a cheaper newer unknown one", () => {
    const obscure = model({ id: "sakana/sakana-namazu", blendedPriceUsdPerM: 0.05, createdAt: LATER + 1000 })
    const known = model({ id: "anthropic/claude-opus-5", blendedPriceUsdPerM: 1.1, createdAt: LATER })

    expect(pickBest("main", current, [current, obscure, known], [])?.id).toBe("anthropic/claude-opus-5")
  })

  // Catalog position is not release date. Ordering on the timestamp is what
  // stops "listed on OpenRouter today" from reading as "newer model".
  it("ranks candidates by release date, not catalog position", () => {
    const older = model({ id: "google/gemini-3.7-flash", createdAt: LATER, catalogOrder: 1 })
    const newer = model({ id: "anthropic/claude-opus-5", createdAt: LATER + 5000, catalogOrder: 99 })

    expect(pickBest("main", current, [current, older, newer], [])?.id).toBe("anthropic/claude-opus-5")
  })

  // A trusted vendor is not enough on its own. Both of these are real labs
  // publishing under their own namespace, and both were the newest entries in
  // the catalog, so they won outright before this rule existed.
  it("skips experimental and contributor builds from trusted labs", () => {
    const contributor = model({ id: "meta/muse-spark-1.2-contributor", blendedPriceUsdPerM: 0.17, createdAt: LATER + 900 })
    const experiment = model({ id: "deepseek/deepseek-v4-flash-vision-exp", blendedPriceUsdPerM: 0.55, createdAt: LATER + 800 })
    const shipped = model({ id: "deepseek/deepseek-v4-flash-0731", blendedPriceUsdPerM: 0.15, createdAt: LATER })

    expect(pickBest("main", current, [current, contributor, experiment, shipped], [])?.id)
      .toBe("deepseek/deepseek-v4-flash-0731")
  })

  it("skips a rolling ~latest alias, which would repoint the slot unannounced", () => {
    const alias = model({ id: "~deepseek/deepseek-v4-flash-latest", blendedPriceUsdPerM: 0.15, createdAt: LATER + 500 })
    expect(pickBest("main", current, [current, alias], [])).toBeNull()
  })

  // The suggestion that started this: a free model looks like a 100% saving,
  // but free tiers are rate-limited, which an unattended cron jig experiences
  // as random failure.
  it("does not move a paid slot onto a free model", () => {
    const free = model({ id: "openai/gpt-5.7-mini:free", blendedPriceUsdPerM: 0, createdAt: LATER })
    expect(pickBest("main", current, [current, free], [])).toBeNull()
  })

  it("keeps a free slot on free models", () => {
    const freeCurrent = model({ id: "qwen/qwen3.7-flash:free", blendedPriceUsdPerM: 0, createdAt: JAN })
    const newerFree = model({ id: "google/gemini-3.7-flash:free", blendedPriceUsdPerM: 0, createdAt: LATER })
    const paid = model({ id: "google/gemini-3.7-flash", blendedPriceUsdPerM: 0.4, createdAt: LATER })

    expect(pickBest("main", freeCurrent, [freeCurrent, newerFree, paid], [])?.id)
      .toBe("google/gemini-3.7-flash:free")
  })

  it("does not suggest an older model even when it is cheaper", () => {
    const older = model({ id: "google/gemini-2.0-flash", blendedPriceUsdPerM: 0.1, createdAt: JAN - 5000 })
    expect(pickBest("main", current, [current, older], [])).toBeNull()
  })
})

describe("providerOf", () => {
  it("reads the vendor prefix and ignores the alias marker", () => {
    expect(providerOf("anthropic/claude-opus-5")).toBe("anthropic")
    // OpenRouter publishes `~vendor/...` aliases alongside the real entries.
    expect(providerOf("~anthropic/claude-latest")).toBe("anthropic")
    expect(isFoundationalProvider("~google/gemini-latest")).toBe(true)
    expect(isFoundationalProvider("stealth/ox-alpha")).toBe(false)
  })
})
