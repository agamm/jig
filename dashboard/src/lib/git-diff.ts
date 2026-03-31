export function trimGitDiffHeaders(diff: string): string {
  const lines = diff.split("\n")
  const firstHunkIndex = lines.findIndex((line) => line.startsWith("@@"))
  if (firstHunkIndex === -1) return diff.trim()
  return lines.slice(firstHunkIndex).join("\n").trim()
}
