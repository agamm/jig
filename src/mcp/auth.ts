import { createServer, type Server } from "node:http"
import open from "open"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { getCredential, setCredential } from "../db.js"

type OAuthClientMetadata = OAuthClientProvider["clientMetadata"]
type OAuthClientInformationMixed = NonNullable<Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>>
type OAuthTokens = NonNullable<Awaited<ReturnType<OAuthClientProvider["tokens"]>>>

const CALLBACK_PORT = 9876
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`

/**
 * SQLite-backed OAuth provider for Jig MCP connections.
 * Persists tokens in the `credentials` table under keys
 * `oauth:{server}:{tokens|client|verifier}`.
 */
export class JigOAuthProvider implements OAuthClientProvider {
  private _authResolve?: (code: string) => void
  private _callbackServer?: Server

  constructor(private serverName: string) {}

  get redirectUrl(): string {
    return REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [REDIRECT_URL],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Jig",
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const raw = getCredential(`oauth:${this.serverName}:client`)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as OAuthClientInformationMixed
    } catch {
      return undefined
    }
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    setCredential(`oauth:${this.serverName}:client`, JSON.stringify(info), this.serverName)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const raw = getCredential(`oauth:${this.serverName}:tokens`)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as OAuthTokens
    } catch {
      return undefined
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    setCredential(`oauth:${this.serverName}:tokens`, JSON.stringify(tokens), this.serverName)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.startCallbackServer()
    await open(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    setCredential(`oauth:${this.serverName}:verifier`, codeVerifier, this.serverName)
  }

  async codeVerifier(): Promise<string> {
    const value = getCredential(`oauth:${this.serverName}:verifier`)
    if (!value) {
      throw new Error(`No code verifier saved for ${this.serverName}`)
    }
    return value
  }

  waitForAuthCode(): Promise<string> {
    return new Promise((resolve) => {
      this._authResolve = resolve
    })
  }

  private async startCallbackServer(): Promise<void> {
    if (this._callbackServer) return

    this._callbackServer = createServer((req, res) => {
      if (!req.url || req.url === "/favicon.ico") {
        res.writeHead(404)
        res.end()
        return
      }

      const parsed = new URL(req.url, `http://localhost:${CALLBACK_PORT}`)
      const code = parsed.searchParams.get("code")
      const error = parsed.searchParams.get("error")

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(
          "<html><body><h1>Authorized</h1><p>You can close this window.</p>" +
          "<script>setTimeout(()=>window.close(),1500)</script></body></html>"
        )
        this._authResolve?.(code)
        setTimeout(() => this.stopCallbackServer(), 2000)
      } else {
        res.writeHead(400, { "Content-Type": "text/html" })
        const safeError = (error ?? "Unknown error").replace(/[<>&"']/g, (c) =>
          ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#x27;" })[c] ?? c
        )
        res.end(`<html><body><h1>Error</h1><p>${safeError}</p></body></html>`)
      }
    })

    this._callbackServer.listen(CALLBACK_PORT)
  }

  stopCallbackServer(): void {
    this._callbackServer?.close()
    this._callbackServer = undefined
  }
}
