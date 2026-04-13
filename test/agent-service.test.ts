import { describe, expect, it } from "bun:test"
import { appendAskAnswer, appendAuthoringIntent } from "../src/services/agent-service.js"

describe("agent authoring intent accumulation", () => {
  it("preserves the original instruction when a follow-up message arrives", () => {
    const initial = "Create a jig to find trending GitHub repositories with Apify."
    const combined = appendAuthoringIntent(initial, "Use weekly results and format the output cleanly.")

    expect(combined).toContain(initial)
    expect(combined).toContain("Follow-up instruction:")
    expect(combined).toContain("Use weekly results and format the output cleanly.")
  })

  it("records ask-user answers into the accumulated authoring intent", () => {
    const initial = "Create a jig to email a summary to my team."
    const combined = appendAskAnswer(initial, "What email address should this send to?", "team@example.com")

    expect(combined).toContain(initial)
    expect(combined).toContain("User answer for authoring:")
    expect(combined).toContain("Question: What email address should this send to?")
    expect(combined).toContain("Answer: team@example.com")
  })

  it("ignores empty follow-up messages and empty answers", () => {
    const initial = "Create a manual jig."
    expect(appendAuthoringIntent(initial, "   ")).toBe(initial)
    expect(appendAskAnswer(initial, "Any question", "   ")).toBe(initial)
  })
})
