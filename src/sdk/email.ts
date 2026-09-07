/**
 * The Jig email shell and the block model behind `ctx.email()`.
 *
 * Pure: strings in, strings out. The design rides on inline styles (what every
 * mail client keeps); the <style> block only adds typography for fragments an
 * author wrote by hand. A full document (<html>/<!doctype>) is sent untouched.
 */
import { escapeHtml, looksHtml, markdownishToHtml } from "../text.js"

export type EmailPriority = "high" | "medium" | "low"

export type EmailCard = {
  title: string
  /** One line under the title: why it matters, who, when. */
  detail?: string
  /** Short category label shown as a pill (a project, a person, a source). */
  tag?: string
  /** Makes the title a link. */
  href?: string
  /** high: amber accent and a fire mark on the right. medium: blue accent. low or unset: plain. */
  priority?: EmailPriority
}

export type EmailKvRow = { label: string; value: string; href?: string }

export type EmailBlock =
  | { type: "heading"; title: string; eyebrow?: string; lede?: string }
  | { type: "text"; markdown: string }
  | { type: "cards"; items: EmailCard[]; title?: string }
  | { type: "kv"; rows: EmailKvRow[]; title?: string }

/** The dashboard's tokens (dashboard/src/app/globals.css :root), so mail and UI read as one product. */
export const EMAIL_PALETTE = {
  canvas: "#0a0a0b",
  panel: "#0e0e10",
  surface: "#111113",
  inset: "#0b0b0d",
  border: "#1f1f23",
  text: "#ededed",
  secondary: "#b7b7bd",
  muted: "#8b8b91",
  dim: "#5f5f66",
  faint: "#44444b",
  emerald: "#10b981",
  emeraldSoft: "#5fcfa4",
  amber: "#f59e0b",
} as const

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
const P = EMAIL_PALETTE

const font = (size: number, weight: number, lineHeight: number, color: string) =>
  `font-family:${FONT};font-size:${size}px;font-weight:${weight};line-height:${lineHeight};color:${color}`

// Importance reads like the dashboard's status dots: a mark on the right, never a colored rail.
const PRIORITY_MARK: Record<EmailPriority, string> = {
  high: `<span style="font-size:14px;line-height:1">🔥</span>`,
  medium: `<span style="display:inline-block;width:7px;height:7px;border-radius:999px;background:${P.amber}"></span>`,
  low: "",
}
/** Setup page section label: 10px, uppercase, wide tracking, faint. */
const LABEL = `${font(10, 500, 1.2, P.faint)};letter-spacing:.14em;text-transform:uppercase`
/** Jig list trigger pill: mono 10px on a bordered chip. */
const PILL = `display:inline-block;font-family:${MONO};font-size:10px;line-height:1.2;color:#888;background:${P.inset};border:1px solid ${P.border};border-radius:6px;padding:2px 7px;vertical-align:middle`

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function sectionLabel(text: string | undefined): string {
  if (!text) return ""
  return `<div style="margin:18px 0 8px;${LABEL}">${escapeHtml(text)}</div>`
}

function renderCard(card: EmailCard): string {
  const mark = PRIORITY_MARK[card.priority ?? "low"]
  const title = card.href
    ? `<a href="${escapeHtml(card.href)}" style="${font(13, 500, 1.4, P.text)};text-decoration:none">${escapeHtml(card.title)}</a>`
    : `<span style="${font(13, 500, 1.4, P.text)}">${escapeHtml(card.title)}</span>`
  const pill = card.tag ? ` <span style="${PILL};margin-left:6px">${escapeHtml(card.tag)}</span>` : ""
  const open = card.href ? `${card.detail ? " · " : ""}<a href="${escapeHtml(card.href)}" style="color:${P.emerald};text-decoration:none">Open</a>` : ""
  const detail = card.detail || open ? `<div style="margin-top:2px;${font(12, 400, 1.5, P.muted)}">${card.detail ? escapeHtml(card.detail) : ""}${open}</div>` : ""
  const markCell = mark ? `<td width="24" align="right" style="vertical-align:middle;padding-left:12px">${mark}</td>` : ""
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;margin:0 0 6px"><tr><td style="background:${P.surface};border:1px solid ${P.border};border-radius:8px;padding:10px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="vertical-align:middle"><div>${title}${pill}</div>${detail}</td>${markCell}</tr></table></td></tr></table>`
}

function renderKv(rows: EmailKvRow[]): string {
  const body = rows
    .map((row) => {
      const value = row.href
        ? `<a href="${escapeHtml(row.href)}" style="font-family:${MONO};font-size:12px;line-height:1.5;color:${P.emerald};text-decoration:none">${escapeHtml(row.value)}</a>`
        : `<span style="font-family:${MONO};font-size:12px;line-height:1.5;color:${P.text}">${escapeHtml(row.value)}</span>`
      return `<tr><td style="width:1%;padding:3px 20px 3px 0;vertical-align:top;white-space:nowrap;${font(12, 400, 1.5, P.dim)}">${escapeHtml(row.label)}</td><td style="padding:3px 0;vertical-align:top">${value}</td></tr>`
    })
    .join("")
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;margin:0 0 6px"><tr><td style="background:${P.inset};border:1px solid ${P.border};border-radius:12px;padding:9px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">${body}</table></td></tr></table>`
}

export function renderEmailBlocks(blocks: EmailBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading": {
          const eyebrow = block.eyebrow
            ? `<div style="margin:0 0 6px;${font(10, 500, 1.2, P.emeraldSoft)};letter-spacing:.14em;text-transform:uppercase">${escapeHtml(block.eyebrow)}</div>`
            : ""
          const lede = block.lede ? `<p style="margin:6px 0 0;${font(13, 400, 1.55, P.muted)}">${escapeHtml(block.lede)}</p>` : ""
          return `<div style="margin:0 0 18px">${eyebrow}<h1 style="margin:0;${font(17, 600, 1.35, P.text)};letter-spacing:-.01em">${escapeHtml(block.title)}</h1>${lede}</div>`
        }
        case "text":
          return inlineBaseStyles(markdownishToHtml(block.markdown))
        case "cards":
          return sectionLabel(block.title) + block.items.map(renderCard).join("")
        case "kv":
          return sectionLabel(block.title) + renderKv(block.rows)
      }
    })
    .join("\n")
}

/** Plain-text twin of the blocks, for the text/plain part. */
export function blocksToText(blocks: EmailBlock[]): string {
  const out: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        if (block.eyebrow) out.push(block.eyebrow.toUpperCase())
        out.push(block.title)
        if (block.lede) out.push(block.lede)
        break
      case "text":
        out.push(block.markdown.trim())
        break
      case "cards":
        if (block.title) out.push(block.title.toUpperCase())
        for (const card of block.items) {
          const mark = card.priority === "high" ? "🔥 " : ""
          const bits = [card.tag ? `[${card.tag}]` : "", card.title, card.detail ? `· ${card.detail}` : "", card.href ?? ""]
          out.push(`- ${mark}${bits.filter(Boolean).join(" ")}`)
        }
        break
      case "kv":
        if (block.title) out.push(block.title.toUpperCase())
        for (const row of block.rows) out.push(`${row.label}: ${row.value}${row.href ? ` (${row.href})` : ""}`)
        break
    }
    out.push("")
  }
  return out.join("\n").trim()
}

// ---------------------------------------------------------------------------
// Typography for hand-written fragments
// ---------------------------------------------------------------------------

const BASE_STYLES: Record<string, string> = {
  h1: `margin:0 0 10px;${font(17, 600, 1.35, P.text)};letter-spacing:-.01em`,
  h2: `margin:18px 0 6px;${font(13, 600, 1.4, P.text)}`,
  h3: `margin:18px 0 8px;${LABEL}`,
  p: `margin:0 0 10px;${font(13, 400, 1.55, P.secondary)}`,
  ul: `margin:0 0 10px;padding-left:18px`,
  ol: `margin:0 0 10px;padding-left:18px`,
  li: `margin:0 0 4px;${font(13, 400, 1.55, P.secondary)}`,
  a: `color:${P.emerald};text-decoration:none`,
  hr: `border:0;border-top:1px solid ${P.border};margin:16px 0`,
  blockquote: `margin:0 0 10px;padding:0 0 0 12px;border-left:1px solid ${P.border};${font(13, 400, 1.55, P.muted)}`,
  code: `font-family:${MONO};font-size:12px;color:${P.text};background:${P.surface};border:1px solid ${P.border};border-radius:4px;padding:1px 5px`,
  pre: `font-family:${MONO};font-size:11px;line-height:1.55;color:${P.text};background:${P.inset};border:1px solid ${P.border};border-radius:8px;padding:10px 12px;overflow:auto;margin:0 0 10px`,
  table: `border-collapse:collapse;width:100%;margin:0 0 10px`,
  th: `text-align:left;padding:6px 8px;border-bottom:1px solid ${P.border};${LABEL}`,
  td: `padding:6px 8px;border-bottom:1px solid ${P.border};${font(12, 400, 1.5, P.secondary)};vertical-align:top`,
  strong: `font-weight:600;color:${P.text}`,
}

/** Adds the shell's typography inline on common tags that carry no style of their own. */
export function inlineBaseStyles(fragment: string): string {
  return fragment.replace(/<(h1|h2|h3|p|ul|ol|li|a|hr|blockquote|code|pre|table|th|td|strong)(\s[^>]*)?>/gi, (whole, tag: string, attrs: string | undefined) => {
    if (attrs && /\sstyle\s*=/i.test(attrs)) return whole
    return `<${tag}${attrs ?? ""} style="${BASE_STYLES[tag.toLowerCase()]}">`
  })
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function isFullHtmlDocument(html: string): boolean {
  return /^\s*(<!doctype\s|<html[\s>])/i.test(html)
}

const SHELL_CSS = `body{margin:0;padding:0;background:${P.canvas}}
a{color:${P.emerald}}
.jig-body h1{margin:0 0 10px;font-size:17px;line-height:1.35;font-weight:600;letter-spacing:-.01em;color:${P.text}}
.jig-body h2{margin:18px 0 6px;font-size:13px;line-height:1.4;font-weight:600;color:${P.text}}
.jig-body h3{margin:18px 0 8px;font-size:10px;line-height:1.2;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:${P.faint}}
.jig-body p{margin:0 0 10px}
.jig-body ul,.jig-body ol{margin:0 0 10px;padding-left:18px}
.jig-body li{margin:0 0 4px}
.jig-body hr{border:0;border-top:1px solid ${P.border};margin:16px 0}
.jig-body code{font-family:${MONO};font-size:12px}`

/** Wraps a fragment in the Jig shell: dark canvas, centered panel, header, footer. */
export function renderEmail(opts: { fragment: string; jigName?: string; footer?: string }): string {
  const jigPill = opts.jigName ? `<span style="${PILL};margin-left:8px">${escapeHtml(opts.jigName)}</span>` : ""
  const footer =
    opts.footer ??
    (opts.jigName
      ? `Sent by the <span style="color:${P.muted}">${escapeHtml(opts.jigName)}</span> jig. Reply to this email to change what it sends.`
      : "Sent by Jig.")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<style>${SHELL_CSS}</style>
</head>
<body style="margin:0;padding:0;background:${P.canvas}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${P.canvas}"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%">
<tr><td style="padding:0 2px 10px;${font(13, 600, 1, P.text)}"><span style="display:inline-block;width:7px;height:7px;border-radius:999px;background:#34d399;margin-right:8px;vertical-align:middle"></span><span style="vertical-align:middle">Jig</span>${jigPill}</td></tr>
<tr><td class="jig-body" style="background:${P.panel};border:1px solid ${P.border};border-radius:12px;padding:20px;${font(13, 400, 1.55, P.secondary)}">
${opts.fragment}
</td></tr>
<tr><td style="padding:12px 2px 0;${font(11, 400, 1.5, P.dim)}">${footer}</td></tr>
</table>
</td></tr></table>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// What ctx.email() actually sends
// ---------------------------------------------------------------------------

export type EmailParts = { text?: string; html?: string }

/**
 * Turns what a jig passed to `ctx.email()` into the text and html parts to send.
 * Blocks render into the shell; a fragment is wrapped in it; a full document is
 * the author's own design and goes out untouched. Markdown-looking text becomes
 * the html part too, so "**bold**" never reaches the inbox literally.
 */
export function buildEmailParts(input: {
  text?: string
  html?: string
  blocks?: EmailBlock[]
  jigName?: string
  /** Reply-token footers, appended inside the panel / at the end of the text part. */
  token?: { html: string; text: string }
}): EmailParts {
  let text = input.text
  let fragment: string | undefined
  if (input.blocks) {
    fragment = renderEmailBlocks(input.blocks)
    text ??= blocksToText(input.blocks)
  } else if (input.html != null) {
    fragment = input.html
  } else if (text != null) {
    fragment = looksHtml(text) ? text : markdownishToHtml(text)
  }
  const tokenHtml = input.token?.html ?? ""
  let html: string | undefined
  if (fragment != null) {
    if (isFullHtmlDocument(fragment)) {
      html = tokenHtml ? (/<\/body>/i.test(fragment) ? fragment.replace(/<\/body>/i, `${tokenHtml}</body>`) : fragment + tokenHtml) : fragment
    } else {
      html = renderEmail({ fragment: inlineBaseStyles(fragment) + tokenHtml, jigName: input.jigName })
    }
  }
  return {
    text: input.token && text != null ? `${text}${input.token.text}` : text,
    html,
  }
}
