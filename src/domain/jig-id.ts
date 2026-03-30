const VALID_JIG_ID = /^[a-z0-9][a-z0-9_-]*$/

export function isValidJigId(id: string): boolean {
  return VALID_JIG_ID.test(id)
}
