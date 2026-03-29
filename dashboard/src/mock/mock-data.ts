import type { Jig } from "@/types/jig";

/* ── Jig definitions ── */
export const JIGS_WEEK2: Jig[] = [
  {
    id: "weekly-update", name: "Weekly Update", trigger: "Fri 9am", status: "healthy", costMonth: "$0.15", costLifetime: "$0.30",
    grouped: true, entityCount: 3,
    entities: [
      { name: "Acme", lastRun: "3d ago", status: "success" },
      { name: "Globex", lastRun: "3d ago", status: "fail" },
      { name: "Initech", lastRun: "3d ago", status: "success" },
    ],
    sparkline: [4, 6, 5, 7, 3, 6, 5],
    steps: [
      { num: 1, name: "Read calendar events" },
      { num: 2, name: "Fetch git commits" },
      { num: 3, name: "Search Gmail for updates" },
      { num: 4, name: "Generate update email" },
      { num: 5, name: "Create Gmail draft" },
    ],
    code: `import { calendar, github, gmail, ai } from "jig/tools";\n\nexport default async function weeklyUpdate(client: string) {\n  const events = await calendar.listEvents({ days: 7 });\n  const commits = await github.listCommits({ days: 7 });\n  const emails = await gmail.search(\`from:\${client}\`);\n\n  const draft = await ai.generate({\n    prompt: "Write a weekly update email",\n    context: { events, commits, emails },\n  });\n\n  await gmail.createDraft({\n    to: \`\${client}@example.com\`,\n    subject: "Weekly Update",\n    body: draft,\n  });\n}`,
    runs: [
      { date: "Mar 21", duration: "4.8s", status: "success", cost: "$0.003", steps: [
        { label: "Read calendar events", time: "0.8s", output: "12 events this week" },
        { label: "Fetch git commits", time: "1.2s", output: "47 commits across 3 repos" },
        { label: "Search Gmail for updates", time: "0.9s", output: "8 client emails found" },
        { label: "Generate update email", time: "1.4s", cost: "$0.003", tag: "AI", output: "Draft generated (342 words)" },
        { label: "Create Gmail draft", time: "0.5s", output: "Draft saved to Gmail" },
      ] },
      { date: "Mar 14", duration: "4.2s", status: "fail", cost: "$0.001", steps: [
        { label: "Read calendar events", time: "0.7s", output: "9 events this week" },
        { label: "Fetch git commits", time: "1.1s", output: "32 commits across 3 repos" },
        { label: "Search Gmail for updates", time: "0.8s", healed: true, output: "Retried after timeout, 5 emails found" },
        { label: "Generate update email", time: "0s", output: "Failed: context too large" },
      ] },
      { date: "Mar 7", duration: "5.3s", status: "success", cost: "$0.004", steps: [
        { label: "Read calendar events", time: "0.9s", output: "14 events this week" },
        { label: "Fetch git commits", time: "1.3s", output: "51 commits across 4 repos" },
        { label: "Search Gmail for updates", time: "1.0s", output: "11 client emails found" },
        { label: "Generate update email", time: "1.6s", cost: "$0.004", tag: "AI", output: "Draft generated (387 words)" },
        { label: "Create Gmail draft", time: "0.5s", output: "Draft saved to Gmail" },
      ] },
      { date: "Feb 28", duration: "4.6s", status: "success", cost: "$0.003" },
      { date: "Feb 21", duration: "5.1s", status: "success", cost: "$0.003", steps: [
        { label: "Read calendar events", time: "0.9s", output: "10 events this week" },
        { label: "Fetch git commits", time: "1.3s", output: "38 commits across 3 repos" },
        { label: "Search Gmail for updates", time: "1.0s", output: "7 client emails found" },
        { label: "Generate update email", time: "1.5s", cost: "$0.003", tag: "AI", output: "Draft generated (315 words)" },
        { label: "Create Gmail draft", time: "0.4s", output: "Draft saved to Gmail" },
      ] },
      { date: "Mar 7", duration: "4.5s", status: "fail", cost: "$0.001", steps: [
        { label: "Read calendar events", time: "0.7s", output: "14 events this week" },
        { label: "Fetch git commits", time: "1.1s", healed: true, output: "Retried after auth error, 51 commits" },
        { label: "Search Gmail for updates", time: "0.9s", output: "11 client emails found" },
        { label: "Generate update email", time: "1.3s", cost: "$0.001", tag: "AI", output: "Partial draft (truncated)" },
        { label: "Create Gmail draft", time: "\u2014", output: "Skipped due to upstream failure" },
      ] },
    ],
    settings: { trigger: "Every Friday at 9:00am", connections: ["Gmail", "Calendar", "GitHub"], permissions: [] },
  },
  {
    id: "invoice", name: "Invoice", trigger: "1st of month", status: "attention", costMonth: "$0.08", costLifetime: "$0.42",
    grouped: true, entityCount: 2,
    entities: [
      { name: "Acme", lastRun: "2d ago", status: "success" },
      { name: "Globex", lastRun: "2d ago", status: "success" },
    ],
    sparkline: [3, 2, 4, 3, 5, 2, 4],
    steps: [
      { num: 1, name: "Read timesheet" },
      { num: 2, name: "Find last invoice" },
      { num: 3, name: "Compare hours" },
      { num: 4, name: "Draft invoice email" },
      { num: 5, name: "Wait for approval" },
      { num: 6, name: "Send email" },
    ],
    code: `import { jig, llm } from "jig"
import { workspace } from "jig/connections"

export default jig("invoice-acme", {
  trigger: "every 1st 9am",
  tools: [workspace.drive, workspace.gmail],
}, async (ctx) => {
  const sheet = await workspace.drive_read("timesheet.xlsx")
  const last = await workspace.gmail_search("subject:invoice")
  const diff = await llm("Compare hours", { sheet, last })
  const draft = await llm("Draft invoice", { sheet, diff })
  await ctx.human("Review draft", { show: draft })
  await workspace.gmail_send({ to: "billing@acme.co", body: draft })
})`,
    runs: [
      { date: "Mar 1", duration: "12.3s", status: "success", cost: "$0.005", steps: [
        { label: "Read timesheet", time: "1.2s", output: "168 hours across 22 days. No anomalies." },
        { label: "Find last invoice email", time: "0.9s", output: "Found: Invoice Feb 2026 ($24,000)" },
        { label: "Compare hours and flag changes", time: "3.1s", cost: "$0.003", tag: "AI", output: "+8h vs last month ($24,000 \u2192 $25,200)" },
        { label: "Draft invoice email", time: "2.8s", cost: "$0.002", tag: "AI", output: "To: billing@acme.co\nSubject: Invoice \u2014 March 2026\nAmount: $25,200.00" },
        { label: "Wait for approval", time: "3.5s", output: "Approved by user" },
        { label: "Send email", time: "0.8s", output: "Email sent successfully" },
      ] },
      { date: "Feb 1", duration: "11.8s", status: "success", cost: "$0.005", steps: [
        { label: "Read timesheet", time: "1.1s", output: "160 hours across 20 days. No anomalies." },
        { label: "Find last invoice email", time: "1.0s", output: "Found: Invoice Jan 2026 ($22,500)" },
        { label: "Compare hours and flag changes", time: "2.9s", cost: "$0.003", tag: "AI", output: "+6.7h vs last month ($22,500 \u2192 $24,000)" },
        { label: "Draft invoice email", time: "2.6s", cost: "$0.002", tag: "AI", output: "To: billing@acme.co\nSubject: Invoice \u2014 February 2026\nAmount: $24,000.00" },
        { label: "Wait for approval", time: "3.7s", output: "Approved by user" },
        { label: "Send email", time: "0.5s", output: "Email sent successfully" },
      ] },
    ],
    settings: { trigger: "Every 1st of month at 9:00am", connections: ["Gmail", "Drive"], permissions: [] },
  },
  {
    id: "email-triage", name: "Email Triage", trigger: "Daily 8am", status: "healthy", costMonth: "$0.62", costLifetime: "$1.24",
    sparkline: [7, 6, 8, 7, 5, 8, 7],
    steps: [
      { num: 1, name: "Fetch unread emails" },
      { num: 2, name: "Categorize by priority" },
      { num: 3, name: "Label and archive" },
      { num: 4, name: "Summarize highlights" },
    ],
    code: `import { gmail, ai } from "jig/tools";\n\nexport default async function emailTriage() {\n  const unread = await gmail.list({ unread: true, hours: 24 });\n  const categorized = await ai.classify(unread);\n\n  for (const email of categorized) {\n    await gmail.label(email.id, email.priority);\n  }\n\n  return ai.summarize(categorized);\n}`,
    runs: [
      { date: "Mar 25", duration: "3.2s", status: "success", cost: "$0.003", steps: [
        { label: "Fetch unread emails", time: "0.6s", output: "23 unread emails" },
        { label: "Categorize by priority", time: "1.4s", cost: "$0.002", tag: "AI", output: "3 urgent, 8 normal, 12 low" },
        { label: "Label and archive", time: "0.8s", output: "23 emails labeled, 12 archived" },
        { label: "Summarize highlights", time: "0.4s", cost: "$0.001", tag: "AI", output: "3 action items flagged" },
      ] },
      { date: "Mar 24", duration: "2.9s", status: "success", cost: "$0.003", steps: [
        { label: "Fetch unread emails", time: "0.5s", output: "18 unread emails" },
        { label: "Categorize by priority", time: "1.3s", cost: "$0.002", tag: "AI", output: "2 urgent, 6 normal, 10 low" },
        { label: "Label and archive", time: "0.7s", output: "18 emails labeled, 10 archived" },
        { label: "Summarize highlights", time: "0.4s", cost: "$0.001", tag: "AI", output: "2 action items flagged" },
      ] },
      { date: "Mar 23", duration: "3.5s", status: "success", cost: "$0.003", steps: [
        { label: "Fetch unread emails", time: "0.7s", output: "31 unread emails" },
        { label: "Categorize by priority", time: "1.5s", cost: "$0.002", tag: "AI", output: "5 urgent, 12 normal, 14 low" },
        { label: "Label and archive", time: "0.9s", output: "31 emails labeled, 14 archived" },
        { label: "Summarize highlights", time: "0.4s", cost: "$0.001", tag: "AI", output: "5 action items flagged" },
      ] },
      { date: "Mar 22", duration: "3.1s", status: "success", cost: "$0.003", steps: [
        { label: "Fetch unread emails", time: "0.6s", output: "20 unread emails" },
        { label: "Categorize by priority", time: "1.3s", cost: "$0.002", tag: "AI", output: "2 urgent, 9 normal, 9 low" },
        { label: "Label and archive", time: "0.8s", output: "20 emails labeled, 9 archived" },
        { label: "Summarize highlights", time: "0.4s", cost: "$0.001", tag: "AI", output: "2 action items flagged" },
      ] },
      { date: "Mar 21", duration: "2.8s", status: "success", cost: "$0.002", steps: [
        { label: "Fetch unread emails", time: "0.5s", output: "15 unread emails" },
        { label: "Categorize by priority", time: "1.2s", cost: "$0.001", tag: "AI", output: "1 urgent, 7 normal, 7 low" },
        { label: "Label and archive", time: "0.7s", output: "15 emails labeled, 7 archived" },
        { label: "Summarize highlights", time: "0.4s", cost: "$0.001", tag: "AI", output: "1 action item flagged" },
      ] },
    ],
    settings: { trigger: "Every day at 8:00am", connections: ["Gmail"], permissions: [] },
  },
  {
    id: "meeting-prep", name: "Meeting Prep", trigger: "Before meetings", status: "healthy", costMonth: "$0.31", costLifetime: "$0.62",
    sparkline: [2, 4, 3, 5, 2, 4, 3],
    steps: [
      { num: 1, name: "Check calendar" },
      { num: 2, name: "Fetch attendee context" },
      { num: 3, name: "Generate briefing" },
    ],
    code: `import { calendar, gmail, ai } from "jig/tools";\n\nexport default async function meetingPrep() {\n  const next = await calendar.nextMeeting({ within: "30m" });\n  const context = await gmail.search(\n    \`from:\${next.attendees.join(" OR from:")}\`\n  );\n\n  return ai.summarize({\n    prompt: "Brief me for this meeting",\n    data: { meeting: next, context },\n  });\n}`,
    runs: [
      { date: "Mar 25", duration: "2.1s", status: "success", cost: "$0.002", steps: [
        { label: "Check calendar", time: "0.3s", output: "Next: Project sync in 28 min" },
        { label: "Fetch attendee context", time: "0.9s", output: "3 attendees, 12 recent threads" },
        { label: "Generate briefing", time: "0.9s", cost: "$0.002", tag: "AI", output: "Briefing ready (2 key topics)" },
      ] },
      { date: "Mar 24", duration: "1.9s", status: "success", cost: "$0.002", steps: [
        { label: "Check calendar", time: "0.2s", output: "Next: Client review in 25 min" },
        { label: "Fetch attendee context", time: "0.8s", output: "2 attendees, 8 recent threads" },
        { label: "Generate briefing", time: "0.9s", cost: "$0.002", tag: "AI", output: "Briefing ready (3 key topics)" },
      ] },
      { date: "Mar 23", duration: "2.3s", status: "success", cost: "$0.002", steps: [
        { label: "Check calendar", time: "0.4s", output: "Next: Team standup in 30 min" },
        { label: "Fetch attendee context", time: "1.0s", output: "5 attendees, 15 recent threads" },
        { label: "Generate briefing", time: "0.9s", cost: "$0.002", tag: "AI", output: "Briefing ready (4 key topics)" },
      ] },
    ],
    settings: { trigger: "30 min before calendar events", connections: ["Calendar", "Gmail"], permissions: [] },
  },
  {
    id: "client-onboarding", name: "Client Onboarding", trigger: "Manual", status: "healthy", costMonth: "$0.02", costLifetime: "$0.04",
    sparkline: [0, 1, 0, 0, 1, 0, 0],
    steps: [
      { num: 1, name: "Create Drive folder" },
      { num: 2, name: "Send welcome email" },
      { num: 3, name: "Create calendar series" },
      { num: 4, name: "Set up invoice jig" },
    ],
    code: `import { drive, gmail, calendar } from "jig/tools";\n\nexport default async function onboard(client: string) {\n  await drive.createFolder(\`Clients/\${client}\`);\n  await gmail.send({\n    to: \`contact@\${client}.co\`,\n    template: "welcome",\n  });\n  await calendar.createRecurring({\n    title: \`\${client} Check-in\`,\n    frequency: "weekly",\n  });\n}`,
    runs: [
      { date: "Mar 15", duration: "6.2s", status: "success", cost: "$0.00", steps: [
        { label: "Create Drive folder", time: "1.2s", output: "Created: Clients/Initech/" },
        { label: "Send welcome email", time: "2.1s", output: "Welcome email sent" },
        { label: "Create calendar series", time: "1.8s", output: "Weekly check-in created" },
        { label: "Set up invoice jig", time: "1.1s", output: "Invoice jig cloned for Initech" },
      ] },
    ],
    settings: { trigger: "Manual", connections: ["Drive", "Gmail", "Calendar"], permissions: [] },
  },
];

export const JIGS_MONTH3: Jig[] = [
  ...JIGS_WEEK2,
  {
    id: "contract-tracker", name: "Contract Tracker", trigger: "Weekly", status: "healthy", costMonth: "$0.18", costLifetime: "$0.36",
    sparkline: [1, 1, 2, 1, 1, 2, 1],
    steps: [
      { num: 1, name: "Scan Drive for contracts" },
      { num: 2, name: "Check expiry dates" },
      { num: 3, name: "Alert on expiring" },
    ],
    code: `import { drive, ai, gmail } from "jig/tools";\n\nexport default async function contractTracker() {\n  const contracts = await drive.list("Contracts/");\n  const expiring = await ai.extractDates(contracts)\n    .filter(c => c.daysLeft < 30);\n\n  if (expiring.length) {\n    await gmail.send({\n      to: "me",\n      subject: \`\${expiring.length} contracts expiring soon\`,\n      body: expiring.map(c => c.summary).join("\\n"),\n    });\n  }\n}`,
    runs: [
      { date: "Mar 24", duration: "4.1s", status: "success", cost: "$0.002", steps: [
        { label: "Scan Drive for contracts", time: "1.8s", output: "12 contracts found" },
        { label: "Extract renewal dates", time: "1.5s", cost: "$0.002", tag: "AI", output: "2 expiring within 30 days" },
        { label: "Send reminders", time: "0.8s", output: "2 reminder emails sent" },
      ] },
      { date: "Mar 17", duration: "3.9s", status: "success", cost: "$0.002", steps: [
        { label: "Scan Drive for contracts", time: "1.7s", output: "12 contracts found" },
        { label: "Extract renewal dates", time: "1.4s", cost: "$0.002", tag: "AI", output: "1 expiring within 30 days" },
        { label: "Send reminders", time: "0.8s", output: "1 reminder email sent" },
      ] },
    ],
    settings: { trigger: "Every Monday at 9:00am", connections: ["Drive", "Gmail"], permissions: [] },
  },
  {
    id: "daily-summary", name: "Daily Summary", trigger: "Daily 6pm", status: "healthy", costMonth: "$0.93", costLifetime: "$2.79",
    sparkline: [6, 7, 5, 8, 6, 7, 6],
    steps: [
      { num: 1, name: "Collect all jig runs" },
      { num: 2, name: "Generate summary" },
      { num: 3, name: "Send digest email" },
    ],
    code: `import { jig, ai, gmail } from "jig/tools";\n\nexport default async function dailySummary() {\n  const runs = await jig.todaysRuns();\n  const digest = await ai.summarize(runs);\n  await gmail.send({\n    to: "me",\n    subject: "Daily Jig Summary",\n    body: digest,\n  });\n}`,
    runs: Array.from({ length: 5 }, (_, i) => ({
      date: `Mar ${25 - i}`, duration: `${(1.5 + Math.random() * 0.8).toFixed(1)}s`, status: "success" as const, cost: "$0.002",
      steps: [
        { label: "Collect all jig runs", time: "0.3s", output: `${12 - i} runs today` },
        { label: "Generate summary", time: "0.9s", cost: "$0.002", tag: "AI" as const, output: "Digest generated (5 highlights)" },
        { label: "Send digest email", time: "0.3s", output: "Digest email sent" },
      ],
    })),
    settings: { trigger: "Every day at 6:00pm", connections: ["Gmail"], permissions: [] },
  },
];

/* ── Approval data ── */
export const APPROVAL_DATA: Record<string, {
  jigName: string;
  entity: string;
  connections: string[];
  steps: { name: string; time?: string; status: "done" | "pending" | "future"; tool?: string; cost?: string; input?: string; output?: string }[];
  artifacts: { name: string; desc: string; iconColor: string; svgPaths: string }[];
  output: { to: string; subject: string; amount: string; detail: string; source: string };
}> = {
  "invoice-acme": {
    jigName: "Invoice",
    entity: "Acme",
    connections: ["Gmail", "Drive"],
    steps: [
      { name: "Read timesheet from Drive", time: "0.8s", status: "done", tool: "drive.read", input: "Clients/Acme/timesheet-2026.xlsx", output: "168 hours logged across 22 working days" },
      { name: "Find last invoice email", time: "0.4s", status: "done", tool: "gmail.search", input: 'query: "subject:invoice to:billing@acme.co"', output: "Found: Invoice \u2014 February 2026 ($24,000)" },
      { name: "Compare hours (AI)", time: "1.2s", status: "done", cost: "$0.003", tool: "llm", input: "Timesheet (168h) vs last invoice (160h)", output: "+8 hours vs last month. No anomalies detected." },
      { name: "Send invoice email", status: "pending", tool: "gmail.send" },
      { name: "Confirm delivery", status: "future" },
    ],
    artifacts: [
      { name: "invoice-acme-march-2026.pdf", desc: "Generated invoice \u2014 2 pages, 48KB", iconColor: "text-rose-400", svgPaths: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
      { name: "email-draft.md", desc: "Email body draft \u2014 1.2KB", iconColor: "text-blue-400", svgPaths: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>' },
      { name: "timesheet-diff.json", desc: "Hours comparison \u2014 3 changes flagged", iconColor: "text-emerald-400", svgPaths: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>' },
    ],
    output: { to: "billing@acme.co", subject: "Invoice \u2014 March 2026", amount: "$25,200.00", detail: "168 hours @ $150/hr", source: "Based on timesheet: Clients/Acme/timesheet-2026.xlsx" },
  },
};

/* ── Trigger suggestions ── */
export const TRIGGER_SUGGESTIONS = [
  "Every day at",
  "Every week on",
  "Every month on",
  "Before",
  "After",
  "Manual",
  "On webhook",
];
