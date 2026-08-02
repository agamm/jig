import { describe, expect, it } from "bun:test"
import { looksHtml, looksMarkdownish, markdownishToHtml } from "../src/text.js"

// The body shape that shipped raw "**" to the inbox: an LLM asked for a
// numbered summary + bullet list, concatenated into a ctx.email text body.
const LLM_BODY = `Good morning! Here's what you should wear today:

1. **Today's weather:** Sunny and very hot—around **98°F**, with a low near **74°F**.

2. **Outfit:**
- Lightweight, breathable cotton T-shirt
- Loose shorts or lightweight pants

3. **Advice:** Apply SPF 30+ sunscreen and stay hydrated.

Stay comfortable out there!`

describe("markdownishToHtml", () => {
  it("renders the bold that used to reach the inbox as literal asterisks", () => {
    const html = markdownishToHtml(LLM_BODY)
    expect(html).toContain("<strong>Today&#39;s weather:</strong>")
    expect(html).toContain("<strong>98°F</strong>")
    expect(html).not.toContain("**")
  })

  it("turns a dash run into a single list", () => {
    const html = markdownishToHtml(LLM_BODY)
    expect(html).toContain("<li>Lightweight, breathable cotton T-shirt</li>")
    expect((html.match(/<ul>/g) ?? []).length).toBe(1)
    expect((html.match(/<ul>/g) ?? []).length).toBe((html.match(/<\/ul>/g) ?? []).length)
  })

  it("escapes HTML in the source before emphasis runs", () => {
    expect(markdownishToHtml("a < b & **c**")).toBe("<p>a &lt; b &amp; <strong>c</strong></p>")
  })

  it("converts headings", () => {
    expect(markdownishToHtml("## Today")).toBe("<h2>Today</h2>")
  })
})

describe("looksMarkdownish", () => {
  it("detects the bodies that need conversion", () => {
    expect(looksMarkdownish(LLM_BODY)).toBe(true)
    expect(looksMarkdownish("# Heading")).toBe(true)
    expect(looksMarkdownish("- a bullet")).toBe(true)
  })

  it("leaves prose alone", () => {
    expect(looksMarkdownish("Just a plain sentence, nothing special.")).toBe(false)
  })
})

describe("looksHtml", () => {
  it("recognises an existing HTML body so it is not double-converted", () => {
    expect(looksHtml("<p>already html</p>")).toBe(true)
    expect(looksHtml(LLM_BODY)).toBe(false)
  })
})
