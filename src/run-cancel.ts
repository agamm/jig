export const USER_CANCELLED_MESSAGE = "Cancelled by user"

export function isCancellationMessage(message?: string | null): boolean {
  if (!message) return false
  const normalized = message.trim().toLowerCase()
  return (
    normalized === "run cancelled"
    || normalized === "this operation was aborted"
    || normalized === "request was aborted."
    || normalized === "request was aborted"
    || normalized === "cancelled by user"
    || normalized.includes("aborterror")
  )
}

export function isCancellationError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError" || isCancellationMessage(error.message)
  }
  return isCancellationMessage(typeof error === "string" ? error : String(error))
}
