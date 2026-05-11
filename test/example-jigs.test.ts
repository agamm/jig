import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { listExampleJigs } from "../src/services/example-jigs.js"

describe("example jig catalog", () => {
  it("loads durable example jigs from examples/", () => {
    const examples = listExampleJigs()
    const ids = examples.map((example) => example.id)

    expect(ids).toContain("weekly-update")
    expect(ids).toContain("pre-meeting-briefing")
    expect(ids).toContain("executive-coach-daily")
    expect(examples.every((example) => example.steps.length > 0)).toBe(true)
    expect(examples.every((example) => example.trigger.length > 0)).toBe(true)
    expect(examples.every((example) => example.connections.length > 0)).toBe(true)
    expect(readFileSync("examples/weekly-update.ts", "utf-8")).not.toContain("params:")
  })

  it("uses the expected generated tool names", () => {
    const weekly = readFileSync("examples/weekly-update.ts", "utf-8")
    const briefing = readFileSync("examples/pre-meeting-briefing.ts", "utf-8")
    const coach = readFileSync("examples/executive-coach-daily.ts", "utf-8")

    expect(weekly).toContain("agent<")
    expect(weekly).toContain("workspace.calendar_listEvents")
    expect(weekly).toContain("workspace.gmail_search")
    expect(weekly).toContain("workspace.gmail_get")
    expect(weekly).toContain("workspace.drive_search")
    expect(weekly).toContain("workspace.people_getMe")
    expect(weekly).toContain("workspace.gmail_createDraft")
    expect(weekly).not.toContain("google_calendar_list_events")
    expect(weekly).not.toContain("gmail_search_emails")
    expect(weekly).not.toContain("google_drive_search")
    expect(weekly).not.toContain("gmail_create_draft")

    expect(briefing).toContain("workspace.calendar_listEvents")
    expect(briefing).toContain("workspace.gmail_search")
    expect(briefing).not.toContain("google_calendar_list_events")
    expect(briefing).not.toContain("gmail_search_emails")

    expect(coach).toContain("granola.query_granola_meetings")
    expect(coach).toContain("composio.googlecalendar_events_list")
    expect(coach).toContain("composio.gmail_fetch_emails")
    expect(coach).toContain("composio.gmail_send_email")
    expect(coach).not.toContain("workspace.")
  })

  it("keeps example output inside steps", () => {
    const weekly = readFileSync("examples/weekly-update.ts", "utf-8")
    const briefing = readFileSync("examples/pre-meeting-briefing.ts", "utf-8")
    const coach = readFileSync("examples/executive-coach-daily.ts", "utf-8")

    expect(weekly.match(/ctx\.output\(/g)?.length ?? 0).toBe(1)
    expect(briefing.match(/ctx\.output\(/g)?.length ?? 0).toBe(1)
    expect((coach.match(/ctx\.output\(/g)?.length ?? 0)).toBeGreaterThan(0)
  })
})
