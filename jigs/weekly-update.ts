/**
 * Weekly Client Update
 *
 * Gathers relevant data, writes the email, figures out the recipient,
 * and creates a Gmail draft.
 *
 * Usage: bun run jigs/weekly-update.ts "CompanyName" "repo-name" "Your Name"
 */
import { join } from "path"
import { jig, run, llm, agent } from "../src/index.js"
import { granola } from "../.jig/connections/granola.js"
import { workspace } from "../.jig/connections/workspace.js"
import { github } from "../.jig/connections/github.js"

const template = await Bun.file(join(import.meta.dir, "../templates/weekly-update.md")).text()

const gatherTools = [
  granola.query_granola_meetings,
  granola.list_meetings,
  granola.get_meetings,
  workspace.gmail_search,
  workspace.gmail_get,
  workspace.calendar_listEvents,
  workspace.drive_search,
  workspace.sheets_getText,
  github.search_repositories,
  github.list_commits,
]

const weeklyUpdate = jig(
  "weekly-update",
  {
    params: {
      company: "Company or project name",
      repo: "GitHub repo name",
      name: "Your name for the sign-off",
    },
    tools: [...gatherTools, workspace.gmail_createDraft],
  },
  async (ctx) => {
    const { company, repo, name } = ctx.params
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    })

    // Agent gathers data, writes the email, and identifies the recipient
    const result = await agent<{ email: string; to: string; cc: string; subject: string }>(
      `Write a weekly client update email for "${company}".
Today is ${today}.

Gather data first, then write the email:

1. PREVIOUS UPDATE: Search Gmail for the last weekly update email you sent about "${company}" (try subject lines like "weekly update", "status update", "${company} update"). Read it fully — you'll use this to avoid repeating old news.
2. MEETINGS: Search Granola for meetings about "${company}" from the past week.
   Get full details for relevant ones.
3. EMAILS: Search Gmail for "${company}", read the most relevant emails (up to 5).
4. CALENDAR: List calendar events from the past week.
5. COMMITS: Search GitHub for a repo matching "${repo}", then get recent commits.
6. HOURS: Search Drive for a timesheet for "${company}". If found, read current hours.

After gathering, write the email using this as a loose style guide:

${template}

Sender: ${name}
Structure: what happened this past week, then what's coming up (action items, next steps).
IMPORTANT: Compare against the previous weekly update. Only write about things that are NEW since that last email. Don't repeat items already covered. If something was mentioned before but has progressed, focus only on the new progress.
Be conversational and natural. Plain text only, no markdown.
Keep it short and scannable - a busy executive should get the gist in 30 seconds.
Focus on outcomes and progress, not technical details. Skip implementation specifics like individual commits, PR numbers, or code changes.
Skip sections with no data.

Also figure out:
- The single primary recipient (to) — exactly one email address. Pick the main client contact from meeting participants, email threads, or calendar attendees.
- CC — check the last weekly update email thread for CC'd people. Only include people who were previously CC'd, not every meeting attendee. Never put more than one address in "to".
- A good subject line.`,
      gatherTools,
      { schema: { email: "string", to: "string", cc: "string", subject: "string" } }
    )

    console.log(result.email)

    // Create Gmail draft (deterministic — always happens last)
    const draft = await workspace.gmail_createDraft({
      to: result.to,
      subject: result.subject,
      body: result.email,
      ...(result.cc && { cc: result.cc }),
    })

    // Print draft link
    const draftData = typeof draft === "object" ? draft as any : {}
    const messageId = draftData?.message?.id ?? draftData?.id ?? ""
    console.log(`\nhttps://mail.google.com/mail/u/0/#drafts/${messageId}`)
  }
)

const [company, repo, name] = process.argv.slice(2)
await run(weeklyUpdate, {
  ...(company && { company }),
  ...(repo && { repo }),
  ...(name && { name }),
})

process.exit(0)
