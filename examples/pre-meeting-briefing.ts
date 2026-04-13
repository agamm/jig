// Prepare a quick pre-meeting brief from the next calendar event and recent related email.
import { jig, type Context } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace"

export default jig(
  "pre-meeting-briefing",
  {
    trigger: { type: "manual" },
    tools: [
      workspace.calendar_listEvents,
      workspace.gmail_search,
    ],
  },
  async (ctx: Context) => {
    const events = await ctx.step("Find the next meeting", [workspace.calendar_listEvents], async () => {
      return await workspace.calendar_listEvents({
        calendarId: "primary",
        timeMin: "now",
        timeMax: "now+1d",
      })
    })

    const nextEvent = Array.isArray(events) ? events[0] : null
    const query = typeof nextEvent?.summary === "string" ? nextEvent.summary : "newer_than:14d"
    await ctx.step("Pull recent related email", [workspace.gmail_search], async () => {
      const relatedEmail = await workspace.gmail_search({ query })
      ctx.output([
        `Next event: ${nextEvent?.summary ?? "Unknown"}`,
        `Related emails found: ${Array.isArray(relatedEmail) ? relatedEmail.length : 0}`,
        "Use this pattern to assemble a meeting brief before the call starts.",
      ].join("\n"))
      return relatedEmail
    })
  }
)
