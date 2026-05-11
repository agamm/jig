import { getFastModel } from "../config/models.js"

type TriggerResult = {
  type: string
  cron?: string
  approximate?: boolean
  note?: string
}

export function cronToText(cron: string): string {
  const [min, hour, dom, , dow] = cron.trim().split(/\s+/)
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const time = `${hour}:${min.padStart(2, "0")}`

  if (dow !== "*" && dom === "*") {
    const dayNames = dow.split(",").map((d) => days[parseInt(d)] ?? d).join(", ")
    return `${dayNames} ${time}`
  }
  if (dom !== "*") return `${dom} of month ${time}`
  if (hour !== "*" && min !== "*") return `Daily ${time}`
  if (min.startsWith("*/")) return `Every ${min.slice(2)}m`
  return cron
}

export function textToTrigger(text: string): { type: string; cron?: string } | null {
  const t = text.trim()
  if (!t) return null

  if (/^manual$/i.test(t)) return { type: "manual" }
  if (/^webhook$/i.test(t)) return { type: "webhook" }

  // "every N minutes" → cron */N expression
  const intervalMatch = t.match(/^every\s+(\d+)\s*m(?:in(?:ute)?s?)?$/i)
  if (intervalMatch) {
    const n = parseInt(intervalMatch[1])
    if (n >= 1 && n <= 59) return { type: "cron", cron: `*/${n} * * * *` }
  }

  const dayMap: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }
  const timeAlias: Record<string, [number, number]> = {
    morning: [9, 0], noon: [12, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0], midnight: [0, 0],
  }

  function parseTime(s: string): [number, number] | null {
    const alias = timeAlias[s.trim().toLowerCase()]
    if (alias) return alias
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (!m) return null
    let h = parseInt(m[1])
    const min = m[2] ? parseInt(m[2]) : 0
    if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12
    if (m[3]?.toLowerCase() === "am" && h === 12) h = 0
    return [h, min]
  }

  const dailyMatch = t.match(/^(?:daily|every\s+day(?:\s+at)?)\s+(.+)$/i)
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1])
    if (time) return { type: "cron", cron: `${time[1]} ${time[0]} * * *` }
  }

  const timeAliasPattern = Object.keys(timeAlias).join("|")
  const dayTimeMatch = t.match(new RegExp(`^(?:every\\s+(?:week\\s+on\\s+)?)?([a-z, ]+?)(?:\\s+at)?\\s+(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|${timeAliasPattern})\\s*$`, "i"))
  if (dayTimeMatch) {
    const dayPart = dayTimeMatch[1].toLowerCase().replace(/\s+/g, "")
    const dayNames = dayPart.split(",").map(d => d.trim())
    const dayNums = dayNames.map(d => dayMap[d]).filter(d => d !== undefined)
    if (dayNums.length > 0) {
      const time = parseTime(dayTimeMatch[2])
      if (time) return { type: "cron", cron: `${time[1]} ${time[0]} * * ${dayNums.join(",")}` }
    }
  }

  const monthMatch = t.match(/^(?:every\s+(?:month\s+on\s+(?:the\s+)?)?)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+(?:the\s+)?month\s+)?(?:at\s+)?(.+)$/i)
  if (monthMatch) {
    const time = parseTime(monthMatch[2])
    if (time) return { type: "cron", cron: `${time[1]} ${time[0]} ${monthMatch[1]} * *` }
  }

  return null
}

export async function textToTriggerLLM(text: string): Promise<TriggerResult | null> {
  const { getOpenRouterApiKey } = await import("../config/openrouter.js")
  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return null
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: getFastModel(),
        max_tokens: 2000,
        messages: [
          { role: "system", content: `Convert the user's scheduling description into a JSON trigger object. Return ONLY valid JSON, no explanation.

Possible formats:
- { "type": "cron", "cron": "<5-field cron expression>" }
- { "type": "manual" }
- { "type": "webhook" }

If the request CANNOT be exactly represented in standard 5-field cron (e.g. "odd weeks", "every 3rd Tuesday", "random times"), return the closest approximation AND set "approximate": true with a "note" explaining what was lost.

Examples:
"every friday at 9am" → { "type": "cron", "cron": "0 9 * * 5" }
"twice a day" → { "type": "cron", "cron": "0 9,17 * * *" }
"every 30 minutes" → { "type": "cron", "cron": "*/30 * * * *" }
"odd week tuesdays at 9am" → { "type": "cron", "cron": "0 9 * * 2", "approximate": true, "note": "Cron cannot express odd/even weeks — this will run every Tuesday" }` },
          { role: "user", content: text },
        ],
      }),
    })
    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return null
    const parsed = JSON.parse(content.replace(/^```json?\s*|\s*```$/g, ""))
    return parsed?.type ? parsed : null
  } catch (e) {
    console.error("[trigger-llm]", e)
    return null
  }
}

export function triggerToSource(trigger: { type: string; cron?: string }): string {
  switch (trigger.type) {
    case "cron": return `{ type: "cron", cron: ${JSON.stringify(trigger.cron)} }`
    case "manual": return `{ type: "manual" }`
    case "webhook": return `{ type: "webhook" }`
    default: return `{ type: "manual" }`
  }
}

export function replaceTriggerInSource(code: string, newTrigger: string): string | null {
  const triggerRe = /trigger\s*:\s*\{[^}]*\}/
  if (!triggerRe.test(code)) return null
  return code.replace(triggerRe, `trigger: ${newTrigger}`)
}
