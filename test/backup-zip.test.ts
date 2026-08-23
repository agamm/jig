import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createZip, readZip } from "../src/backup/zip.js"

const text = (s: string) => new TextEncoder().encode(s)
const str = (b: Uint8Array) => new TextDecoder().decode(b)

describe("zip", () => {
  it("round-trips entries in order", () => {
    const entries = [
      { name: "manifest.json", data: text('{"version":1}') },
      { name: "jigs/daily-digest.ts", data: text("export default jig(...)") },
    ]

    const read = readZip(createZip(entries))

    expect(read.map((e) => e.name)).toEqual(["manifest.json", "jigs/daily-digest.ts"])
    expect(str(read[1].data)).toBe("export default jig(...)")
  })

  it("preserves content that compresses badly and content that compresses well", () => {
    const random = new Uint8Array(4096).map((_, i) => (i * 2654435761) % 256)
    const repetitive = text("x".repeat(20_000))

    const read = readZip(createZip([
      { name: "random.bin", data: random },
      { name: "repeat.txt", data: repetitive },
    ]))

    expect(read[0].data).toEqual(random)
    expect(str(read[1].data)).toBe("x".repeat(20_000))
  })

  it("handles an empty file and unicode in both name and content", () => {
    const read = readZip(createZip([
      { name: "empty.txt", data: text("") },
      { name: "jigs/café ☕.ts", data: text("// naïve ☕ café") },
    ]))

    expect(read[0].data.length).toBe(0)
    expect(read[1].name).toBe("jigs/café ☕.ts")
    expect(str(read[1].data)).toBe("// naïve ☕ café")
  })

  it("produces an archive the operating system's unzip accepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-zip-"))
    const path = join(dir, "backup.zip")
    writeFileSync(path, createZip([
      { name: "manifest.json", data: text('{"version":1}') },
      { name: "jigs/a.ts", data: text("const a = 1") },
    ]))

    const proc = Bun.spawn(["unzip", "-t", path], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited

    expect(code).toBe(0)
    expect(out).toContain("No errors detected")
  })

  it("rejects a file that is not a zip, by name", () => {
    expect(() => readZip(text("this is not a zip"))).toThrow(/not a valid zip/i)
  })

  it("rejects an archive whose contents were altered after packing", () => {
    const zip = createZip([{ name: "a.txt", data: text("original") }])
    // Flip a byte inside the compressed payload; the stored CRC no longer matches.
    zip[40] = zip[40] ^ 0xff

    expect(() => readZip(zip)).toThrow(/checksum/i)
  })
})
