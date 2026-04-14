import { describe, expect, it } from "bun:test"
import {
  normalizeConversationHistory,
  renderConversationIntent,
} from "../src/services/agent-service.js"

describe("agent authoring intent accumulation", () => {
  it("normalizes explicit conversation history and appends the latest user message once", () => {
    const history = normalizeConversationHistory([
      { role: "user", content: "Create a jig for GitHub trending via Apify." },
      { role: "assistant", content: "I need the target timeframe." },
      { role: "user", content: "last week" },
    ], "last week")

    expect(history).toEqual([
      { role: "user", content: "Create a jig for GitHub trending via Apify." },
      { role: "assistant", content: "I need the target timeframe." },
      { role: "user", content: "last week" },
    ])
  })

  it("ignores malformed turns and trims messages", () => {
    const history = normalizeConversationHistory([
      { role: "user", content: "  Create a manual jig.  " },
      { role: "assistant", content: "   " },
      { role: "system", content: "ignore me" },
      null,
    ], "  Add a webhook trigger.  ")

    expect(history).toEqual([
      { role: "user", content: "Create a manual jig." },
      { role: "user", content: "Add a webhook trigger." },
    ])
  })

  it("renders full conversation transcripts for authoring context", () => {
    const transcript = renderConversationIntent([
      { role: "user", content: "Create a jig for GitHub trending via Apify." },
      { role: "assistant", content: "I can do that. What timeframe?" },
      { role: "user", content: "Use last week and output here." },
    ])

    expect(transcript).toContain("User: Create a jig for GitHub trending via Apify.")
    expect(transcript).toContain("Assistant: I can do that. What timeframe?")
    expect(transcript).toContain("User: Use last week and output here.")
  })
})
