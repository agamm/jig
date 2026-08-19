import { describe, expect, it } from "bun:test"
import { pickBest } from "../src/services/model-upgrade.js"
import type { OpenRouterModelInfo } from "../src/services/openrouter-catalog.js"

const model = (over: Partial<OpenRouterModelInfo> & { id: string }): OpenRouterModelInfo => ({
  name: over.id,
  contextLength: 1_000_000,
  promptPriceUsdPerM: 1,
  completionPriceUsdPerM: 1,
  blendedPriceUsdPerM: 1,
  supportsTools: true,
  supportsReasoning: true,
  supportsImages: false,
  createdAt: 1_700_000_000,
  rank: 40,
  ...over,
})

const current = model({ id: "openai/gpt-5.6-luna-pro", blendedPriceUsdPerM: 1, rank: 40 })

describe("pickBest", () => {
  // A :batch model is cheaper and better ranked, so it looked like a pure win
  // and got suggested. It is an async queue endpoint, not a drop-in for a
  // synchronous call — a jig awaiting one would hang far past its run timeout.
  it("never suggests a :batch variant", () => {
    const batch = model({ id: "google/gemini-3.7-flash:batch", blendedPriceUsdPerM: 0.75, rank: 5 })
    expect(pickBest("main", current, [current, batch], [])).toBeNull()
  })

  it("still suggests the non-batch model of the same family", () => {
    const batch = model({ id: "google/gemini-3.7-flash:batch", blendedPriceUsdPerM: 0.75, rank: 5 })
    const plain = model({ id: "google/gemini-3.7-flash", blendedPriceUsdPerM: 0.9, rank: 6 })
    expect(pickBest("main", current, [current, batch, plain], [])?.id).toBe("google/gemini-3.7-flash")
  })

  it("does not reject a model that merely has batch in its name", () => {
    const ok = model({ id: "acme/batcher-1", blendedPriceUsdPerM: 0.5, rank: 3 })
    expect(pickBest("main", current, [current, ok], [])?.id).toBe("acme/batcher-1")
  })
})
