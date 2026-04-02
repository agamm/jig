import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { PROJECT_ROOT } from "../config/paths.js"

const SECRET_PATH = join(PROJECT_ROOT, ".jig", "webhook-secret")

function getServerSecret(): string {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, "utf-8").trim()
  const secret = crypto.randomUUID()
  mkdirSync(join(PROJECT_ROOT, ".jig"), { recursive: true })
  writeFileSync(SECRET_PATH, secret)
  return secret
}

let _secret: string | null = null

export function webhookToken(jigId: string): string {
  if (!_secret) _secret = getServerSecret()
  const hmac = new Bun.CryptoHasher("sha256")
  hmac.update(_secret + ":" + jigId)
  return hmac.digest("hex").slice(0, 32)
}

export function validateWebhookToken(jigId: string, token: string): boolean {
  return token === webhookToken(jigId)
}
