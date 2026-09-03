// Brief yourself before your next meeting, using what was said in the last one.
// Uses the granola connection.
import { jig, llm, type Context } from "@jig/sdk"
import { granola } from "@jig/connections/granola.js"

function brief(value: unknown, max = 1200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}

export default jig(
  "pre-meeting-briefing",
  {
    trigger: { type: "manual" },
    tools: [granola.query_granola_meetings],
  },
  async (ctx: Context) => {
    let upcoming = ""
    let history = ""

    await ctx.step("Find the next meeting", [granola.query_granola_meetings], async () => {
      // query_granola_meetings is the calendar-aware tool. list_meetings and
      // get_meetings only return meetings Granola already took notes for, so
      // they are all in the past and cannot answer "what is next".
      const result = await granola.query_granola_meetings({
        query: "What meetings start in the next 24 hours? Give titles, start times and attendees.",
      })
      upcoming = brief(result)
      ctx.output(upcoming || "Nothing scheduled in the next 24 hours.")
    })

    await ctx.step("Recall the last conversation", [granola.query_granola_meetings], async () => {
      const result = await granola.query_granola_meetings({
        query: `For these upcoming meetings, what was decided or promised last time with the same people or on the same topic? Quote concrete commitments.\n\n${upcoming}`,
      })
      history = brief(result)
      ctx.output(history || "No prior notes found for these attendees.")
    })

    await ctx.step("Write the brief", [], async () => {
      const text = String(
        await llm(
          `Write a pre-meeting brief. Under 150 words, plain text, no markdown.

Three labelled lines, nothing else:
CONTEXT: what this meeting is and who is in it.
OPEN LOOP: the most important thing left unresolved last time.
ASK: the one question worth walking in with.

If the evidence does not support a line, write "none found" rather than inventing one.

UPCOMING:
${upcoming || "(none)"}

PRIOR NOTES:
${history || "(none)"}`,
          { maxTokens: 400 },
        ),
      ).trim()

      await ctx.email({ subject: "Pre-meeting brief", text })
      ctx.output(text)
    })
  },
)
