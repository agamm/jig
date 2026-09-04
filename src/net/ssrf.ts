/**
 * SSRF guard for server-side fetches of caller/LLM-supplied URLs.
 *
 * Validates that a URL is http(s) and that its host does not point at a
 * loopback / private / link-local / cloud-metadata address. Hostnames are
 * DNS-resolved so a public name pointing at an internal IP (e.g. an attacker
 * domain aliased to 169.254.169.254) is still rejected.
 *
 * Callers must still avoid silently following redirects to a different host.
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BlockedUrlError"
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const o = Number(p)
    if (o > 255) return null
    n = n * 256 + o
  }
  return n >>> 0
}

function inV4Range(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base)
  if (b === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ip & mask) === (b & mask)
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true
  return (
    inV4Range(n, "0.0.0.0", 8) ||        // "this" network
    inV4Range(n, "10.0.0.0", 8) ||       // private
    inV4Range(n, "100.64.0.0", 10) ||    // CGNAT (some metadata)
    inV4Range(n, "127.0.0.0", 8) ||      // loopback
    inV4Range(n, "169.254.0.0", 16) ||   // link-local incl. 169.254.169.254 metadata
    inV4Range(n, "172.16.0.0", 12) ||    // private
    inV4Range(n, "192.0.0.0", 24) ||     // IETF protocol assignments
    inV4Range(n, "192.168.0.0", 16) ||   // private
    inV4Range(n, "198.18.0.0", 15) ||    // benchmarking
    inV4Range(n, "224.0.0.0", 4) ||      // multicast
    inV4Range(n, "240.0.0.0", 4)         // reserved incl. 255.255.255.255
  )
}

function isBlockedIpv6(ip: string): boolean {
  const lc = ip.toLowerCase().split("%")[0] // drop zone id
  if (lc === "::1" || lc === "::") return true
  // IPv4-mapped, dotted form (::ffff:1.2.3.4).
  const mapped = lc.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (mapped) return isBlockedIpv4(mapped[1])
  // IPv4-mapped, hex form (::ffff:a9fe:a9fe) — URL parsers normalize to this.
  const mappedHex = lc.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return isBlockedIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }
  if (/^fe[89ab]/.test(lc)) return true // fe80::/10 link-local
  if (/^f[cd]/.test(lc)) return true    // fc00::/7 unique-local
  if (/^fec/.test(lc)) return true       // fec0::/10 site-local (deprecated)
  return false
}

function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return isBlockedIpv4(ip)
  if (fam === 6) return isBlockedIpv6(ip)
  return true // not a parseable IP — fail closed
}

/** Validate an http(s) URL whose host resolves only to public addresses. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUrlError("Not a valid absolute URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("Only http:// and https:// URLs are allowed")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "") // strip IPv6 brackets

  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError(`Blocked address: ${host}`)
    return url
  }
  // Names that commonly front internal services — reject before even resolving.
  if (/^(localhost|(.*\.)?(local|internal|localhost|home\.arpa))$/i.test(host)) {
    throw new BlockedUrlError(`Blocked host: ${host}`)
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    throw new BlockedUrlError(`Could not resolve host: ${host}`)
  }
  if (addrs.length === 0) throw new BlockedUrlError(`Host did not resolve: ${host}`)
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new BlockedUrlError(`Host ${host} resolves to a blocked address (${a.address})`)
    }
  }
  return url
}
