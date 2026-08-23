import { describe, expect, it } from "bun:test"
import { collapseHtmlTagWhitespace } from "../src/text.js"

describe("collapseHtmlTagWhitespace", () => {
  // A pretty-printed template arrived with a <br> after every block tag,
  // because the delivery path converts newlines in an html body to <br>.
  it("removes the newlines between tags that become stray line breaks", () => {
    const pretty = `<div>\n  <h2>Title</h2>\n  <ul>\n    <li>One</li>\n  </ul>\n</div>`

    expect(collapseHtmlTagWhitespace(pretty)).toBe(
      `<div><h2>Title</h2><ul><li>One</li></ul></div>`
    )
  })

  it("leaves text content alone, including newlines inside an element", () => {
    const withText = `<p>first line\nsecond line</p>\n<p>next</p>`

    expect(collapseHtmlTagWhitespace(withText)).toBe(`<p>first line\nsecond line</p><p>next</p>`)
  })

  it("preserves significant spacing between inline tags", () => {
    // A single space between two spans is rendered, so it must survive.
    expect(collapseHtmlTagWhitespace(`<span>a</span> <span>b</span>`)).toBe(
      `<span>a</span> <span>b</span>`
    )
  })

  it("does not reformat pre blocks, where newlines are the content", () => {
    const code = `<div>\n<pre>line one\nline two</pre>\n</div>`

    expect(collapseHtmlTagWhitespace(code)).toBe(`<div><pre>line one\nline two</pre></div>`)
  })

  it("is a no-op on html that was already emitted on one line", () => {
    const oneLine = `<p>Hello</p><ul><li>x</li></ul>`

    expect(collapseHtmlTagWhitespace(oneLine)).toBe(oneLine)
  })
})
