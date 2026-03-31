import { jig, agent, llm } from "../src/index.js"
import { workspace } from "../.jig/connections/workspace.js"

const gatherTools = [
  workspace.gmail_search,
  workspace.gmail_get,
]

const forgottenEmails = jig(
  "forgotten-emails",
  {
    trigger: { type: "manual" },
    tools: gatherTools,
  },
  async (ctx) => {
    ctx.output("Scanning Gmail for emails you might have forgotten to reply to...")

    const result = await agent(
      `Find emails in my inbox that I received but probably forgot to reply to.
      
Look for:
1. Emails where I was directly addressed (e.g., "Hi [my name]", "Hey [my name]", with my email in To: or CC:)
2. Emails that ask questions or require a response
3. Emails from colleagues, clients, or important contacts
4. Threads where I'm the last to reply (no pending replies from me)
5. Emails that are not spam or automated newsletters
6. Messages that are more than 24 hours old but less than 2 weeks old (recent enough to matter)

Prioritize:
- Emails from people I work with regularly
- Emails with clear questions or requests
- Emails where the sender is waiting on me

Skip:
- Automated notifications (GitHub, calendar invites, system alerts)
- Newsletters and marketing emails
- Personal emails that don't require a response
- Threads where someone else is expected to reply next

For each email you find, provide:
- Subject
- Sender
- Date received
- Why it might need a reply (what was asked)
- How urgent it seems (high/medium/low)

Be thorough but concise. Search my inbox carefully.`,
      gatherTools
    )

    ctx.output("\n" + result)

    const summary = await llm(
      `Based on the email scan results, provide a brief summary:
1. How many emails were found that likely need replies
2. The most urgent ones that should be handled today
3. Any patterns (e.g., all from same person, all about same topic)`,
      { scanResults: result }
    )

    ctx.output("\n" + summary)
  }
)

export default forgottenEmails