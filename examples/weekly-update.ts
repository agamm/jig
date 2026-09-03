// Draft a weekly client update on Friday afternoon, gathered by an agent from meeting notes.
// Uses the granola connection.
//
// The counterpart to pre-meeting-briefing: that one is plain code plus llm(),
// this one hands a tool set to agent() and lets it decide what to look up.
import { jig, agent, type Context } from "@jig/sdk"
import { granola } from "@jig/connections/granola.js"

// Identity is hardcoded on purpose. Discovering your own name at runtime costs a
// tool call on something that never changes.
const SENDER_NAME = "Your Name"

const gatherTools = [
  granola.query_granola_meetings,
  granola.list_meetings,
  granola.get_meeting_transcript,
]

export default jig(
  "weekly-update",
  {
    trigger: { type: "cron", cron: "0 16 * * 5" },
    tools: gatherTools,
  },
  async (ctx: Context) => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })

    const update = await ctx.step("Gather the week and write the update", gatherTools, async () => {
      return await agent<{ subject: string; body: string }>(
        `Write this week's client update. Today is ${today}, signed by ${SENDER_NAME}.

Gather first, then write:
1. Ask about this week's meetings: what shipped, what slipped, what was decided.
2. Pull a transcript only when a decision is unclear and the detail matters.
3. Check the prior week so you report what CHANGED, not the standing state.

Then write the email:
- Plain text, no markdown, under 200 words.
- Lead with what moved. Group by project when there is more than one.
- Name the next concrete step and who owns it.
- Do not invent hours, budgets, or dates. If the notes do not say, leave it out.
- End with one open question if there is a real one, otherwise no question.

Return JSON with a subject and a body.`,
        gatherTools,
        { schema: { subject: "string", body: "string" } },
      )
    })

    await ctx.step("Send it for review", [], async () => {
      const subject = update.subject.trim() || `Weekly update: ${today}`
      // Mailed to you, not the client. Reply to the message to have the
      // authoring agent revise this jig.
      await ctx.email({ subject, text: update.body })
      ctx.output([`Subject: ${subject}`, "", update.body].join("\n"))
    })
  },
)
