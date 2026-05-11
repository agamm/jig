// Send a compact executive coaching note from meetings, calendar, and recent email signal.
import { jig, llm, type Context } from "@jig/sdk"
import { granola } from "@jig/connections/granola"
import { composio } from "@jig/connections/composio"

const RECIPIENT_EMAIL = "you@example.com"

type EmailSignal = {
  subject: string
  sender: string
  snippet: string
}

type CoachingSection = {
  label: string
  text: string
}

function brief(value: unknown, max = 900): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return text.replace(/\s+/g, " ").trim().slice(0, max)
}

function itemText(item: unknown): string {
  if (!item || typeof item !== "object") return brief(item, 160)
  const record = item as Record<string, any>
  return brief(record.summary ?? record.title ?? record.subject ?? record.name ?? record.snippet ?? item, 180)
}

function emailSignals(result: unknown): EmailSignal[] {
  const messages = Array.isArray(result) ? result : (result as any)?.messages ?? []
  return messages.slice(0, 5).map((message: any) => ({
    subject: String(message?.subject ?? "(no subject)"),
    sender: String(message?.from ?? message?.sender ?? "(unknown sender)"),
    snippet: brief(message?.snippet ?? message, 160),
  }))
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char] ?? char)
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim()
}

function parseCoachingSections(note: string): CoachingSection[] {
  const clean = normalizeMarkdown(note)
  const labels = ["TENSION", "PATTERN", "HARD QUESTION", "TODAY'S MOVE"]
  const found = labels
    .map((label) => ({ label, index: clean.toUpperCase().indexOf(`${label}:`) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)

  if (found.length === 0) return [{ label: "Note", text: clean }]

  return found.map((entry, index) => {
    const start = entry.index + entry.label.length + 1
    const end = found[index + 1]?.index ?? clean.length
    return {
      label: entry.label,
      text: clean.slice(start, end).trim(),
    }
  }).filter((section) => section.text)
}

function coachingHtml(note: string, dateLabel: string): string {
  const sections = parseCoachingSections(note)
  const sectionHtml = sections.map((section) => `
        <tr>
          <td style="padding:16px 0;border-top:1px solid #2a2a2e;">
            <div style="margin:0 0 7px;color:#17d4a7;font-size:11px;line-height:1.2;font-weight:800;letter-spacing:.14em;text-transform:uppercase;">${escapeHtml(section.label)}</div>
            <div style="margin:0;color:#f2f2f2;font-size:18px;line-height:1.48;font-weight:600;">${escapeHtml(section.text)}</div>
          </td>
        </tr>`).join("")

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f1ea;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f1ea;margin:0;padding:0;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;width:100%;background:#111113;border:1px solid #2a2a2e;border-radius:22px;overflow:hidden;">
            <tr>
              <td style="padding:28px 30px 10px 30px;">
                <div style="color:#17d4a7;font-size:12px;line-height:1.2;font-weight:800;letter-spacing:.18em;text-transform:uppercase;">Executive Coach</div>
                <div style="margin-top:10px;color:#f7f7f8;font-size:34px;line-height:1.05;font-weight:800;letter-spacing:-.04em;">${escapeHtml(dateLabel)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:2px 30px 8px 30px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
${sectionHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 30px 24px 30px;color:#a3a3a8;font-size:12px;line-height:1.4;border-top:1px solid #2a2a2e;">
                Built to be read in under one minute.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export default jig(
  "executive-coach-daily",
  {
    trigger: { type: "cron", cron: "0 8 * * *" },
    tools: [
      granola.query_granola_meetings,
      composio.googlecalendar_events_list,
      composio.gmail_fetch_emails,
      composio.gmail_send_email,
    ],
  },
  async (ctx: Context) => {
    let meetingSignal = ""
    let calendarSignal = ""
    let inboxSignal: EmailSignal[] = []

    await ctx.step("Find leadership signal", [granola.query_granola_meetings], async () => {
      const result = await granola.query_granola_meetings({
        query: [
          "This week, what repeated decisions, unresolved commitments,",
          "delegation gaps, strategic tradeoffs, or leadership bottlenecks showed up?",
          "Return only concrete evidence from meeting notes.",
        ].join(" "),
      })
      meetingSignal = brief(result, 1200)
      ctx.output(meetingSignal || "No meeting-note signal found.")
    })

    await ctx.step("Check calendar and inbox pressure", [composio.googlecalendar_events_list, composio.gmail_fetch_emails], async () => {
      const now = new Date()
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() - 7)

      const events = await composio.googlecalendar_events_list({
        calendar_id: "primary",
        timeMin: weekStart.toISOString(),
        timeMax: now.toISOString(),
        single_events: true,
        order_by: "startTime",
        max_results: 20,
      })
      const eventList = Array.isArray(events) ? events : (events as any)?.items ?? []
      calendarSignal = eventList.slice(0, 8).map(itemText).filter(Boolean).join("\n")

      const emails = await composio.gmail_fetch_emails({
        query: "newer_than:7d -category:promotions -category:social -label:SPAM -label:TRASH",
        max_results: 8,
        user_id: "me",
      })
      inboxSignal = emailSignals(emails)

      ctx.output([
        `Calendar items: ${eventList.length}`,
        `Email signals: ${inboxSignal.length}`,
      ].join("\n"))
    })

    const note = await ctx.step("Write the coaching note", [], async () => {
      const result = await llm(
        `Write a compact executive coaching note from this evidence.

Avoid generic motivation, therapy language, and famous-framework filler.
Prefer sharp tradeoffs, patterns, and operational leverage.
Keep it under 180 words.

Return exactly these four labels:
TENSION: one sentence on the real tradeoff.
PATTERN: one sentence on the repeated behavior or system gap.
HARD QUESTION: one uncomfortable question.
TODAY'S MOVE: one concrete action that fits in 30 minutes.

Plain text only. Do not use Markdown, headings, bullets, bold markers, or a title.

MEETING SIGNAL:
${meetingSignal || "(none)"}

CALENDAR SIGNAL:
${calendarSignal || "(none)"}

INBOX SIGNAL:
${inboxSignal.map((email) => `- ${email.subject} from ${email.sender}: ${email.snippet}`).join("\n") || "(none)"}`,
        { maxTokens: 420 }
      )
      const text = String(result).trim()
      ctx.output(text)
      return text
    })

    await ctx.step("Send executive coaching email", [composio.gmail_send_email], async () => {
      const dateLabel = new Date().toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
      await composio.gmail_send_email({
        recipient_email: RECIPIENT_EMAIL,
        subject: `Executive coach: ${dateLabel}`,
        body: coachingHtml(note, dateLabel),
        is_html: true,
        user_id: "me",
      })
      ctx.output([
        `Email sent to ${RECIPIENT_EMAIL}`,
        "",
        note,
      ].filter(Boolean).join("\n"))
    })
  }
)
