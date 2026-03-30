import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const API_PORT = process.env.JIG_API_PORT ?? "4173"
const API_BASE = `http://localhost:${API_PORT}`
const MAX_RETRIES = 3
const RETRY_DELAY = 300

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const url = `${API_BASE}${pathname}${search}`

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined,
      })

      return new NextResponse(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers),
      })
    } catch (e: any) {
      const isConnectionError = e?.code === "ECONNRESET" || e?.code === "ECONNREFUSED" || e?.message?.includes("socket hang up")
      if (isConnectionError && attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)))
        continue
      }

      console.warn(`[proxy] ${pathname} → backend unavailable${attempt > 0 ? ` (${attempt + 1} attempts)` : ""}`)

      return NextResponse.json(
        { error: "Backend server is restarting, please retry" },
        { status: 503 },
      )
    }
  }

  return NextResponse.json({ error: "Backend unavailable" }, { status: 503 })
}

export const config = {
  matcher: "/api/:path*",
}
