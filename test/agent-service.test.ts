import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb, upsertAgentSession } from "../src/db.js"
import {
  listUnderConstructionJigs,
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

describe("under construction jigs", () => {
  beforeEach(() => {
    closeDb()
    openDb(":memory:")
  })

  afterEach(() => {
    closeDb()
  })

  function upsertDraftSession(overrides: { jigId?: string | null } = {}) {
    upsertAgentSession({
      session_id: "12345678-1234-4234-9234-123456789abc",
      jig_id: overrides.jigId ?? null,
      creation_mode: 1,
      authoring_intent: "User: Test",
      conversation_history: JSON.stringify([{ role: "user", content: "Test" }]),
      authoring_policy: JSON.stringify({ requiresIntegration: false, buildResolutions: [] }),
      messages: JSON.stringify([{ role: "user", content: "Test" }]),
      events: JSON.stringify([{ type: "text", content: "Working" }]),
      status: "waiting",
      metrics: JSON.stringify({ round: 1 }),
      created_at: 100,
      updated_at: 200,
      pending_ask_tool_call_id: null,
      pending_ask_question: null,
      draft_file_path: null,
      draft_approval: null,
      last_event_seq: 0,
    })
  }

  it("keeps the list id stable when a draft receives its target jig id", async () => {
    upsertDraftSession()

    let [draft] = await listUnderConstructionJigs()
    expect(draft.id).toBe("draft-12345678")
    expect(draft.name).toBe("Test")
    expect(draft.underConstruction?.sessionId).toBe("12345678-1234-4234-9234-123456789abc")

    upsertDraftSession({ jigId: "test_jig" })
    ;[draft] = await listUnderConstructionJigs()
    expect(draft.id).toBe("draft-12345678")
    expect(draft.name).toBe("Test Jig")
    expect(draft.underConstruction?.jigId).toBe("test_jig")
  })
})
