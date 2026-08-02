import { afterEach, describe, expect, it } from "bun:test"
import { fetchLockState, promptHiddenPassword, unlockRemote } from "../src/cli-remote/unlock.js"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = ((input: any, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as unknown as typeof fetch
}

describe("promptHiddenPassword", () => {
  it("returns null instead of blocking when stdin is not a TTY", async () => {
    // The deploy hook calls this unattended; blocking here would hang CI and
    // any agent-driven deploy forever.
    expect(process.stdin.isTTY).toBeFalsy()
    expect(await promptHiddenPassword()).toBeNull()
  })
})

describe("fetchLockState", () => {
  it("reads locked + version from health", async () => {
    stubFetch(() => new Response(JSON.stringify({ locked: true, version: "0.1.83" })))
    expect(await fetchLockState("https://x.test")).toEqual({
      locked: true, version: "0.1.83", reachable: true,
    })
  })

  it("reports unreachable rather than throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch
    expect(await fetchLockState("https://x.test")).toEqual({ locked: false, reachable: false })
  })

  it("treats a non-200 health as unreachable", async () => {
    stubFetch(() => new Response("nope", { status: 502 }))
    expect((await fetchLockState("https://x.test")).reachable).toBe(false)
  })
})

describe("unlockRemote", () => {
  it("posts the password and returns the session cookie", async () => {
    let seen: any = null
    stubFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "set-cookie": "jig-admin=tok123; Path=/; HttpOnly" },
      })
    })
    expect(await unlockRemote("https://x.test", "hunter2")).toBe("tok123")
    expect(seen.url).toBe("https://x.test/api/unlock")
    expect(seen.body).toEqual({ password: "hunter2" })
  })

  it("throws with the status on a bad password", async () => {
    stubFetch(() => new Response("Invalid password", { status: 401 }))
    expect(unlockRemote("https://x.test", "wrong")).rejects.toThrow("401")
  })

  it("returns null when no cookie comes back", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: true })))
    expect(await unlockRemote("https://x.test", "pw")).toBeNull()
  })
})
