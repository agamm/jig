import { jig, agent } from "jig"
import { granola } from "jig/connections/granola.js"
import { workspace } from "jig/connections/workspace.js"

const gatherTools = [
  workspace.calendar_listEvents,
  workspace.calendar_getEvent,
  workspace.gmail_search,
  workspace.gmail_get,
  granola.query_granola_meetings,
  granola.get_meetings,
]

const preMeetingBriefing = jig(
  "pre-meeting-briefing",
  {
    trigger: { type: "manual" },
    tools: [...gatherTools, workspace.gmail_send],
  },
  async (ctx) => {
    const events = await ctx.step("Get upcoming meetings", [
      workspace.calendar_listEvents,
    ], async () => {
      ctx.output("Looking for upcoming meetings in the next 24 hours...")
      const now = new Date()
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

      const result = await workspace.calendar_listEvents({
        calendarId: "primary",
        timeMin: now.toISOString(),
        timeMax: tomorrow.toISOString(),
      })

      const items = Array.isArray(result) ? result : (result as any)?.items ?? []
      const filtered = items.filter((e: any) => {
        if (!e.start?.dateTime) return false
        const summary = (e.summary ?? "").toLowerCase()
        if (["holiday", "observance"].some(k => summary.includes(k))) return false
        return true
      })
      ctx.output(`Found ${filtered.length} upcoming meeting(s)`)
      return filtered
    })

    if (!events || events.length === 0) return

    for (const event of events) {
      const eventSummary = event.summary || "Untitled Meeting"
      const eventTime = new Date(event.start?.dateTime || event.start?.date)
      const formattedTime = eventTime.toLocaleString()

      const briefing = await ctx.step("Research meeting context", [
        workspace.calendar_getEvent,
        workspace.gmail_search,
        workspace.gmail_get,
        granola.query_granola_meetings,
        granola.get_meetings,
      ], async () => {
        ctx.output(`Preparing briefing for: ${eventSummary} (${formattedTime})`)

        const details = await workspace.calendar_getEvent({
          eventId: event.id,
          calendarId: "primary",
        })
        const attendees = details?.attendees?.map((a: any) => a.email) || []
        const description = details?.description || ""

        return agent<{ briefing: string; subject: string }>(
          `Create a pre-meeting briefing for: "${eventSummary}"
Meeting time: ${formattedTime}
${description ? `Description: ${description}` : ""}
${attendees.length > 0 ? `Attendees: ${attendees.join(", ")}` : ""}

Gather relevant information:
1. PREVIOUS MEETINGS: Search Granola for past meetings with similar titles or participants.
2. RELATED EMAILS: Search Gmail for emails related to this meeting topic or participants.
3. ACTION ITEMS: Look for pending action items from previous meetings.

Create a rich HTML briefing with meeting title, key participants, previous context, relevant emails, action items, and questions to prepare. Keep it concise.
Also create an appropriate subject line.`,
          [workspace.gmail_search, workspace.gmail_get, granola.query_granola_meetings, granola.get_meetings],
          { schema: { briefing: "string", subject: "string" } }
        )
      })

      await ctx.step("Send briefing email", [workspace.gmail_send], async () => {
        await workspace.gmail_send({
          to: "your-email@example.com",
          subject: briefing.subject,
          body: briefing.briefing,
          isHtml: true,
        })
        ctx.output(`Briefing sent for: ${eventSummary}`)
      })
    }
  }
)

export default preMeetingBriefing
