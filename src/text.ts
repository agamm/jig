export function firstLineSummary(text?: string | null): string {
  const normalized = text?.replace(/\r\n/g, "\n").trim()
  if (!normalized) return ""
  return normalized.split("\n").find((line) => line.trim())?.trim() ?? ""
}

// ---------------------------------------------------------------------------
// Markdown → HTML for outbound email
//
// LLM output is markdown by default, and mail clients render text/plain
// literally — so an unconverted body shows "**bold**" to the reader. Both send
// paths need the same treatment: MCP gmail_send (mcp/client.ts) and ctx.email
// (sdk/context.ts). Shared here so the two can't drift.
//
// Deliberately not a full markdown parser — headings, bullets, bold, italic.
// Anything else degrades to a paragraph, which renders fine.
// ---------------------------------------------------------------------------

/** True when a body carries markdown syntax a mail client would show raw. */
export function looksMarkdownish(text: string): boolean {
  return /\*\*[^*\n]{1,120}\*\*|^\s{0,3}#{1,6}\s+|^\s{0,3}[-*]\s+/m.test(text)
}

/** True when a body is already HTML and should not be re-converted. */
export function looksHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text)
}

export function markdownishToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const chunks: string[] = []
  let listOpen = false

  const closeList = () => {
    if (!listOpen) return
    chunks.push("</ul>")
    listOpen = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      closeList()
      chunks.push(`<h2>${inlineMarkdownToHtml(heading[1])}</h2>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      if (!listOpen) {
        chunks.push("<ul>")
        listOpen = true
      }
      chunks.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`)
      continue
    }
    closeList()
    chunks.push(`<p>${inlineMarkdownToHtml(line)}</p>`)
  }
  closeList()

  return chunks.join("\n")
}

/** Strip markdown left inside a body the caller already marked as HTML. */
export function cleanupMarkdownInHtml(html: string): string {
  return html
    .replace(/(^|[\n>])\s{0,3}#{1,6}\s+/g, "$1")
    .replace(/\*\*([^*<>]{1,120})\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\n>])\s{0,3}>\s+/g, "$1")
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]{1,120})\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]{1,120})\*/g, "<em>$1</em>")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
