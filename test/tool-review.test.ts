import { describe, expect, it } from "bun:test"
import { buildRemovalInstruction, getReviewableToolKeys, toolKey } from "../dashboard/src/lib/tool-review"
import { getToolsetSignature } from "../dashboard/src/lib/jig-tool-approval"
import { trimGitDiffHeaders } from "../dashboard/src/lib/git-diff"

describe("tool review helpers", () => {
  it("falls back to the flat tool list when no steps were derived", () => {
    const tools = [
      { connection: "workspace", name: "gmail_search", readOnly: true },
      { connection: "llm", name: "llm(anthropic/claude-haiku-4.5)", readOnly: true },
    ]

    expect([...getReviewableToolKeys([], tools)]).toEqual([
      toolKey(tools[0]),
      toolKey(tools[1]),
    ])
  })

  it("builds a readable removal instruction for multiple tools", () => {
    expect(buildRemovalInstruction([
      { connection: "workspace", name: "gmail_search", readOnly: true },
      { connection: "workspace", name: "gmail_get", readOnly: true },
    ])).toBe("Remove gmail_search and gmail_get from this jig and adjust the workflow if needed.")
  })

  it("uses a stable signature when the toolset did not change", () => {
    const a = [
      { connection: "workspace", name: "gmail_get", readOnly: true },
      { connection: "workspace", name: "gmail_search", readOnly: true },
    ]
    const b = [
      { connection: "workspace", name: "gmail_search", readOnly: true },
      { connection: "workspace", name: "gmail_get", readOnly: true },
    ]

    expect(getToolsetSignature(a)).toBe(getToolsetSignature(b))
  })

  it("removes git file headers from diff output", () => {
    const raw = [
      "diff --git a/foo.ts b/foo.ts",
      "index 123..456 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    ].join("\n")

    expect(trimGitDiffHeaders(raw)).toBe([
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    ].join("\n"))
  })
})
