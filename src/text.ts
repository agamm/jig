export function firstLineSummary(text?: string | null): string {
  const normalized = text?.replace(/\r\n/g, "\n").trim()
  if (!normalized) return ""
  return normalized.split("\n").find((line) => line.trim())?.trim() ?? ""
}
