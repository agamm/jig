import { jig, agent, llm } from "jig"
import { workspace } from "jig/connections/workspace.js"

const gatherTools = [
  workspace.gmail_search,
  workspace.gmail_get,
]

const forgottenEmails = jig(
  "forgotten-emails",
  {
    trigger: { type: "manual" },
    tools: [...gatherTools, workspace.gmail_send],
  },
  async (ctx) => {
    const result = await ctx.step("Scan for unreplied emails", gatherTools, async () => {
      ctx.output("Scanning Gmail for emails you might have forgotten to reply to...")
      return agent(
        `Find emails in my inbox that I should have replied to but haven't.

Look for messages from colleagues/clients (not automated alerts or newsletters) where:
- I was addressed directly (To:/CC:)
- Questions were asked or a response is expected
- The thread shows no reply from me
- They're 1-14 days old (recent but not immediate)

Prioritize work contacts with clear requests. Skip newsletters, notifications, and personal emails.

For each, show: subject, sender, date, why it needs reply, urgency (high/medium/low).`,
        gatherTools
      )
    })

    ctx.output("\n" + result)

    const summary = await ctx.step("Summarize findings", [], async () => {
      return llm(
        `Based on the email scan results, provide a brief summary:
1. How many emails were found that likely need replies
2. The most urgent ones that should be handled today
3. Any patterns (e.g., all from same person, all about same topic)`,
        { scanResults: result }
      )
    })

    ctx.output("\n" + summary)

    await ctx.step("Send summary email", [workspace.gmail_send], async () => {
      const emailBody = await llm(
        `Create a professional email summarizing forgotten emails that need replies.

Use this format:
- Subject line: "Emails needing your reply: [date]"
- Brief introduction explaining what this is
- List of emails that need replies (from the scan results)
- Clear priorities (high/medium/low)
- Suggested next steps

Make it actionable and easy to scan. Use plain text only.`,
        { scanResults: result, summary }
      )

      await workspace.gmail_send({
        to: "your-email@example.com",
        subject: `Emails needing your reply: ${new Date().toLocaleDateString()}`,
        body: emailBody as string,
      })
      ctx.output("\nEmail summary sent")
    })
  }
)

export default forgottenEmails
