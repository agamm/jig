import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const API_PORT = process.env.JIG_API_PORT ?? "4173"
const API_BASE = `http://localhost:${API_PORT}`
const MAX_RETRIES = 5
const RETRY_DELAY = 500

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const url = `${API_BASE}${pathname}${search}`

  // Read body once for non-GET requests
  const body = request.method !== "GET" && request.method !== "HEAD"
    ? await request.arrayBuffer()
    : undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: request.method,
        headers: {
          "content-type": request.headers.get("content-type") ?? "application/json",
          "accept": request.headers.get("accept") ?? "*/*",
        },
        body,
      })

      return new NextResponse(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers),
      })
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)))
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
