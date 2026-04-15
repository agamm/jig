import { createServer, type Server } from "node:http"
import open from "open"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import { getCredential, setCredential } from "../db.js"

type OAuthClientMetadata = OAuthClientProvider["clientMetadata"]
type OAuthClientInformationMixed = NonNullable<Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>>
type OAuthTokens = NonNullable<Awaited<ReturnType<OAuthClientProvider["tokens"]>>>

const CALLBACK_PORT = 9876
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`
const DASHBOARD_PORT = process.env.JIG_DASHBOARD_PORT ?? "3141"
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#x27;" })[c] ?? c
  )
}

function renderCallbackPage(input: {
  title: string
  eyebrow: string
  message: string
  tone: "success" | "error"
  primaryHref: string
  primaryLabel: string
  detail?: string
  autoClose?: boolean
}): string {
  const accent = input.tone === "success" ? "#34d399" : "#fb7185"
  const accentSoft = input.tone === "success" ? "rgba(52,211,153,0.12)" : "rgba(251,113,133,0.12)"
  const detail = input.detail ? `<p class="detail">${escapeHtml(input.detail)}</p>` : ""
  const autoCloseScript = input.autoClose
    ? `<script>setTimeout(()=>window.close(),1600)</script>`
    : ""

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0a0a0b;
        --surface: #111113;
        --border: #1f1f23;
        --text: #ededed;
        --muted: #888;
        --soft: #555;
        --accent: ${accent};
        --accent-soft: ${accentSoft};
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(255,255,255,0.04), transparent 32rem),
          linear-gradient(180deg, #0d0d0f 0%, var(--bg) 100%);
        color: var(--text);
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(100%, 560px);
        background: rgba(17,17,19,0.94);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 64px rgba(0,0,0,0.45);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        padding: 7px 12px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--accent);
        background: var(--accent-soft);
        border: 1px solid rgba(255,255,255,0.06);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 6px var(--accent-soft);
      }
      h1 {
        margin: 18px 0 10px;
        font-size: clamp(28px, 5vw, 42px);
        line-height: 1.05;
        letter-spacing: -0.03em;
      }
      p {
        margin: 0;
        font-size: 16px;
        line-height: 1.6;
        color: var(--muted);
      }
      .detail {
        margin-top: 10px;
        color: var(--soft);
        font-size: 13px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 24px;
      }
      .btn {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 12px 16px;
        text-decoration: none;
        font-size: 14px;
        font-weight: 600;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease, color 120ms ease;
      }
      .btn:hover { transform: translateY(-1px); }
      .btn-primary {
        background: linear-gradient(180deg, #10b981 0%, #059669 100%);
        border-color: rgba(16,185,129,0.42);
        color: white;
      }
      .btn-secondary {
        background: #17171a;
        color: var(--text);
      }
      .footer {
        margin-top: 18px;
        color: var(--soft);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <span class="badge"><span class="dot"></span>${escapeHtml(input.eyebrow)}</span>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
      ${detail}
      <div class="actions">
        <a class="btn btn-primary" href="${escapeHtml(input.primaryHref)}">${escapeHtml(input.primaryLabel)}</a>
        <a class="btn btn-secondary" href="#" onclick="window.close(); return false;">Close Window</a>
      </div>
      <p class="footer">If this tab does not close automatically, return to Jig and continue there.</p>
    </main>
    ${autoCloseScript}
  </body>
</html>`
}

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
        res.end(renderCallbackPage({
          tone: "success",
          eyebrow: `${this.serverName} connected`,
          title: "Authorization complete",
          message: "Your account is connected. Return to Jig to finish setup and refresh the tool catalog.",
          detail: `Connected service: ${this.serverName}`,
          primaryHref: `${DASHBOARD_URL}/?view=connections&connection=${encodeURIComponent(this.serverName)}`,
          primaryLabel: "Return to Jig",
          autoClose: true,
        }))
        this._authResolve?.(code)
        setTimeout(() => this.stopCallbackServer(), 2000)
      } else {
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(renderCallbackPage({
          tone: "error",
          eyebrow: `${this.serverName} failed`,
          title: "Authorization failed",
          message: "Jig could not finish connecting this service. Return to the dashboard and try again.",
          detail: error ?? "Unknown error",
          primaryHref: `${DASHBOARD_URL}/?view=connections&connection=${encodeURIComponent(this.serverName)}`,
          primaryLabel: "Back to connections",
        }))
        setTimeout(() => this.stopCallbackServer(), 2000)
      }
    })

    this._callbackServer.listen(CALLBACK_PORT)
  }

  stopCallbackServer(): void {
    this._callbackServer?.close()
    this._callbackServer = undefined
  }
}
