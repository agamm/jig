import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const API_PORT = process.env.JIG_API_PORT ?? "4173"
// 127.0.0.1 (not `localhost`) so this always hits the Bun API's IPv4 loopback
// bind — `localhost` can resolve to ::1 first, which the API doesn't listen on.
const API_BASE = `http://127.0.0.1:${API_PORT}`
const MAX_RETRIES = 5
const RETRY_DELAY = 500

// Headers the browser sets that we DO NOT want to forward to the Bun server
// (either would confuse it or Node/fetch rejects them).
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

function forwardHeaders(src: Headers): Headers {
  const out = new Headers()
  src.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value)
  })
  return out
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const url = `${API_BASE}${pathname}${search}`

  const body = request.method !== "GET" && request.method !== "HEAD"
    ? await request.arrayBuffer()
    : undefined

  const fwd = forwardHeaders(request.headers)

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: request.method, headers: fwd, body })

      // Preserve Set-Cookie (can appear multiple times) and every other
      // response header as-is by passing the Headers object straight through.
      return new NextResponse(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY * (attempt + 1)))
        continue
      }
      return NextResponse.json(
        { error: "Backend server is starting, please refresh" },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({ error: "Backend unavailable" }, { status: 503 })
}

export const config = {
  matcher: "/api/:path*",
}
