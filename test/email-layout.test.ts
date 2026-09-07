import { describe, expect, it } from "bun:test"
import { blocksToText, buildEmailParts, inlineBaseStyles, isFullHtmlDocument, renderEmail, renderEmailBlocks, type EmailBlock } from "../src/sdk/email"

describe("renderEmail", () => {
  it("wraps a fragment in the shell with the jig name in header and footer", () => {
    const html = renderEmail({ fragment: "<p>hello</p>", jigName: "daily-digest" })
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("<p>hello</p>")
    expect(html).toContain("background:#0a0a0b")
    expect(html.match(/daily-digest/g)?.length).toBe(2)
    expect(html).toContain("Reply to this email to change what it sends.")
  })

  it("escapes the jig name", () => {
    expect(renderEmail({ fragment: "", jigName: "<b>x</b>" })).not.toContain("<b>x</b>")
  })
})

describe("isFullHtmlDocument", () => {
  it("recognizes full documents and not fragments", () => {
    expect(isFullHtmlDocument("<!doctype html><html><body>x</body></html>")).toBe(true)
    expect(isFullHtmlDocument("  <html lang=\"en\">")).toBe(true)
    expect(isFullHtmlDocument("<h2>Title</h2><p>x</p>")).toBe(false)
  })
})

describe("inlineBaseStyles", () => {
  it("styles bare tags and leaves styled ones and text alone", () => {
    const out = inlineBaseStyles(`<h2>Hi</h2><p style="color:red">keep</p><a href="https://x.y">l</a> plain <abbr title="t">a</abbr>`)
    expect(out).toMatch(/<h2 style="[^"]*font-size:13px/)
    expect(out).not.toMatch(/style="[^"]*"[^>]*"[^>]*>/)
    expect(out).toContain(`<p style="color:red">keep</p>`)
    expect(out).toMatch(/<a href="https:\/\/x\.y" style="color:#10b981/)
    expect(out).toContain(`<abbr title="t">a</abbr>`)
  })
})

describe("renderEmailBlocks", () => {
  const blocks: EmailBlock[] = [
    { type: "heading", eyebrow: "Saturday, September 5", title: "Clear the follow-ups", lede: "Two items block Monday." },
    {
      type: "cards",
      title: "Focus",
      items: [
        { title: "Review the deck", detail: "due Friday", tag: "Client A", priority: "high", href: "https://example.com/deck" },
        { title: "Reschedule the call", priority: "medium" },
        { title: "Send <script>alert(1)</script>" },
      ],
    },
    { type: "kv", title: "Today", rows: [{ label: "Meetings", value: "None" }, { label: "Weather", value: "Sunny", href: "https://example.com/w" }] },
    { type: "text", markdown: "Notes:\n- **bold** point\n- second" },
  ]
  const html = renderEmailBlocks(blocks)

  it("renders the heading with eyebrow and lede", () => {
    expect(html).toContain("SATURDAY, SEPTEMBER 5".length > 0 ? "Saturday, September 5" : "")
    expect(html).toMatch(/<h1[^>]*>Clear the follow-ups<\/h1>/)
    expect(html).toContain("Two items block Monday.")
  })

  it("marks importance on the right with a fire mark or an amber dot, never a colored rail", () => {
    const cards = html.split("<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"border-collapse:separate").slice(1, 4)
    const [high, medium, plain] = cards
    expect(high).toContain("🔥")
    expect(high).toContain(`href="https://example.com/deck"`)
    expect(high).toContain(">Open</a>")
    expect(high).toMatch(/font-family:ui-monospace[^"]*">Client A</)
    expect(medium).not.toContain("🔥")
    expect(medium).toContain("width:7px;height:7px;border-radius:999px;background:#f59e0b")
    expect(plain).not.toContain("🔥")
    expect(plain).not.toContain("background:#f59e0b")
    expect(plain).not.toContain("<script>")
    expect(plain).toContain("&lt;script&gt;")
    for (const card of cards) expect(card).not.toMatch(/border-left:\s*[2-9]px/)
  })

  it("renders key/value rows with optional links and converts markdown text", () => {
    expect(html).toMatch(/Meetings<\/td><td[^>]*><span style="font-family:ui-monospace[^"]*">None/)
    expect(html).toContain(`href="https://example.com/w"`)
    expect(html).toContain("<strong style=")
    expect(html).toMatch(/<ul style="[^"]*">\s*<li style=/)
  })

  it("has a readable plain-text twin", () => {
    const text = blocksToText(blocks)
    expect(text).toContain("SATURDAY, SEPTEMBER 5")
    expect(text).toContain("- 🔥 [Client A] Review the deck · due Friday https://example.com/deck")
    expect(text).toContain("Meetings: None")
    expect(text).toContain("- **bold** point")
  })
})

describe("buildEmailParts", () => {
  it("wraps a fragment, keeps the token footer inside the panel", () => {
    const parts = buildEmailParts({ html: "<h2>Digest</h2><p>x</p>", jigName: "digest", token: { html: "<p>ref #abc</p>", text: "\nref #abc" } })
    expect(parts.text).toBeUndefined()
    expect(parts.html).toContain("<!doctype html>")
    expect(parts.html!.indexOf("ref #abc")).toBeLessThan(parts.html!.indexOf("</body>"))
    expect(parts.html).toMatch(/<h2 style=/)
  })

  it("converts markdown text into the html part and keeps the text part", () => {
    const parts = buildEmailParts({ text: "# Hi\n- **one**\n- two", jigName: "digest", token: { html: "<p>ref</p>", text: "\nref" } })
    expect(parts.text).toBe("# Hi\n- **one**\n- two\nref")
    expect(parts.html).toContain("<strong style=")
    expect(parts.html).toContain("<!doctype html>")
  })

  it("leaves a full document alone apart from the token footer", () => {
    const doc = "<!doctype html><html><body><p>mine</p></body></html>"
    const parts = buildEmailParts({ html: doc, jigName: "digest", token: { html: "<p>ref</p>", text: "\nref" } })
    expect(parts.html).toBe("<!doctype html><html><body><p>mine</p><p>ref</p></body></html>")
    expect(buildEmailParts({ html: doc }).html).toBe(doc)
  })

  it("renders blocks and derives the text part from them", () => {
    const parts = buildEmailParts({ blocks: [{ type: "heading", title: "Hello" }], jigName: "digest" })
    expect(parts.text).toBe("Hello")
    expect(parts.html).toMatch(/<h1[^>]*>Hello<\/h1>/)
  })
})
