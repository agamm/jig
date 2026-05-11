"use client"

import { trimGitDiffHeaders } from "@/lib/git-diff"

/**
 * Renders a unified diff as colored monospace lines. Strips git/file headers
 * and hunk markers so the view focuses on additions/removals/context.
 */
export function DiffOutput({ diff, maxHeight = "max-h-64" }: { diff: string; maxHeight?: string }) {
  const normalizedDiff = trimGitDiffHeaders(diff)
  const visibleLines = normalizedDiff
    .split("\n")
    .filter((line) => !line.startsWith("@@"))

  return (
    <pre className={`${maxHeight} overflow-auto rounded-md border border-[#1f1f23] bg-[#0a0a0b] p-3 text-[10px] leading-relaxed`}>
      {visibleLines.map((line, index) => {
        const cls = line.startsWith("+")
          ? "text-emerald-300"
          : line.startsWith("-")
            ? "text-rose-300"
            : "text-[#8b8b91]"
        return <div key={index} className={cls}>{line || " "}</div>
      })}
    </pre>
  )
}
