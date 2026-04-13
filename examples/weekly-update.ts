// Build a weekly client update draft by letting the agent gather relevant workspace context first.
import { join } from "path"
import { jig, agent, type Context } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace"

const template = await Bun.file(join(import.meta.dir, "../templates/weekly-update.md")).text()
const defaultRecipient = "client@example.com"
const defaultCc = ""

const gatherTools = [
  workspace.gmail_search,
  workspace.gmail_get,
  workspace.calendar_listEvents,
  workspace.drive_search,
  workspace.people_getMe,
]

export default jig(
  "weekly-update",
  {
    trigger: { type: "cron", cron: "0 16 * * 5" },
    tools: [
      ...gatherTools,
      workspace.gmail_createDraft,
    ],
  },
  async (ctx: Context) => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })

    const result = await ctx.step("Gather data and write update", gatherTools, async () => {
      return await agent<{
        email: string
        to: string
        cc: string
        subject: string
      }>(
        `Write a weekly client update email draft.
Today is ${today}.

Gather data first, then write the email:

1. PREVIOUS UPDATE: Search Gmail for the last weekly update email you sent. Try queries like "subject:(weekly update)" or "newer_than:30d weekly update", then read the most relevant message fully so you avoid repeating old news.
2. MEETINGS: List recent calendar events from the last 7 days and use them to understand what progressed.
3. EMAILS: Search Gmail for relevant recent client/project emails from the last 7 days, then read the most relevant ones.
4. DOCS: Search Drive for recently updated client/project docs or timesheets from this week when useful.
5. PROFILE: Use the profile tool if needed to determine the sender identity.

After gathering, write the email using this style guide:

${template}

Requirements:
- Plain text only, no markdown.
- Keep it short and scannable.
- Focus on what changed since the previous weekly update.
- Skip implementation details unless they materially matter.
- If hours/cap data isn't available, do not invent it.
- Choose one best primary recipient and optional CC only if the evidence is strong from prior email threads.
- If you cannot confidently determine a recipient, fall back to ${defaultRecipient} so the draft is still reviewable.
- Return a concise subject line.

Return structured JSON with:
- email
- to
- cc
- subject`,
        gatherTools,
        { schema: { email: "string", to: "string", cc: "string", subject: "string" } }
      )
    })

    await ctx.step("Create the update draft", [workspace.gmail_createDraft], async () => {
      const to = result.to.trim() || defaultRecipient
      const cc = result.cc.trim() || defaultCc
      const subject = result.subject.trim() || "Weekly update"
      const draft = await workspace.gmail_createDraft({
        to,
        subject,
        body: result.email,
        ...(cc ? { cc } : {}),
      })
      const draftData = typeof draft === "object" ? draft as Record<string, any> : {}
      const messageId = draftData?.message?.id ?? draftData?.id ?? ""
      ctx.output([
        `To: ${to}`,
        `CC: ${cc || "(none)"}`,
        `Subject: ${subject}`,
        "",
        result.email,
        ...(messageId ? ["", `Draft: https://mail.google.com/mail/u/0/#drafts/${messageId}`] : []),
      ].join("\n"))
    })
  }
)
