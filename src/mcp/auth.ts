import { createServer, type Server } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import open from "open"
import type {
  OAuthClientProvider,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/client/auth.js"

const TOKENS_DIR = join(homedir(), ".jig", "tokens")
const CALLBACK_PORT = 9876
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`

async function ensureTokensDir() {
  await mkdir(TOKENS_DIR, { recursive: true })
}

function tokenPath(serverName: string) {
  return join(TOKENS_DIR, `${serverName}.json`)
}

function clientPath(serverName: string) {
  return join(TOKENS_DIR, `${serverName}_client.json`)
}

function verifierPath(serverName: string) {
  return join(TOKENS_DIR, `${serverName}_verifier.txt`)
}

/**
 * File-based OAuth provider for Jig MCP connections.
 * Persists tokens to ~/.jig/tokens/ and opens the browser for auth flows.
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
      redirect_uris: [new URL(REDIRECT_URL)],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Jig",
    }
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    try {
      const file = Bun.file(clientPath(this.serverName))
      if (!(await file.exists())) return undefined
      return await file.json()
    } catch {
      return undefined
    }
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await ensureTokensDir()
    await Bun.write(clientPath(this.serverName), JSON.stringify(info, null, 2))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    try {
      const file = Bun.file(tokenPath(this.serverName))
      if (!(await file.exists())) return undefined
      return await file.json()
    } catch {
      return undefined
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await ensureTokensDir()
    await Bun.write(tokenPath(this.serverName), JSON.stringify(tokens, null, 2))
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.startCallbackServer()
    await open(authorizationUrl.toString())
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await ensureTokensDir()
    await Bun.write(verifierPath(this.serverName), codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const file = Bun.file(verifierPath(this.serverName))
    if (!(await file.exists())) {
      throw new Error(`No code verifier saved for ${this.serverName}`)
    }
    return await file.text()
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
