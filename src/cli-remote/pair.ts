/**
 * `jig pair <code>` — redeem a one-time code from the dashboard's Setup page
 * and cache the admin session it grants.
 *
 * Exists so the step after a deploy is something you can paste into a coding
 * agent. The alternative was `jig unlock`, which prompts for the instance
 * password, and a password is the one thing that must not travel through a chat.
 */
import { getRemote, listRemotes, resolveActiveRemote, saveRemote, setSessionCookie } from "./manifest.js"

export async function runPair(argv: string[]): Promise<void> {
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const positional = argv.filter((a) => !a.startsWith("--"))
  const code = positional[0]
  const handleArg = positional[1]
  const urlFlag = flag("url")?.replace(/\/$/, "")

  if (!code) {
    console.error("Usage: jig pair <code> [handle] [--url=https://...]")
    console.error("Get a code from the dashboard's Setup page, under Connect the CLI.")
    process.exit(1)
  }

  // A URL given explicitly wins, so this works before any manifest exists.
  let handle = handleArg
  let url = urlFlag
  if (!url) {
    if (listRemotes().length === 0) {
      console.error("No deployed instances known here. Pass --url=https://<your-instance> as well.")
      process.exit(1)
    }
    const remote = resolveActiveRemote(handle)
    handle = remote.handle
    url = remote.public_url
  }

  const res = await fetch(`${url}/api/cli/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  }).catch((e) => {
    console.error(`Could not reach ${url}: ${e?.message ?? e}`)
    process.exit(1)
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    console.error(body.error ?? `Pairing failed (HTTP ${res.status}).`)
    console.error("Codes are single use and expire after 10 minutes. Generate a fresh one and retry.")
    process.exit(1)
  }

  const { token } = (await res.json()) as { token: string }

  // No manifest yet (paired straight from a URL): write a minimal one so later
  // commands can find this instance by handle.
  const derivedHandle = handle ?? new URL(url).hostname.split(".")[0]
  if (!getRemote(derivedHandle)) {
    saveRemote({
      handle: derivedHandle,
      target: "railway",
      public_url: url,
      created_at: new Date().toISOString(),
    })
  }
  setSessionCookie(derivedHandle, token)
  console.log(`Paired with ${derivedHandle} (${url}). Session cached for 30 days.`)
}
