/**
 * Minimal ZIP reader/writer.
 *
 * A backup has to be openable by whoever is holding it two years from now,
 * without jig installed, so the container is a plain .zip rather than anything
 * bespoke. Everything jig stores is text, so this only needs the one format
 * feature that matters: DEFLATE (method 8), which `Bun.deflateSync` already
 * emits raw, exactly as ZIP wants it. No dependency, ~150 lines.
 *
 * Deliberately not a general ZIP implementation. No zip64, no encryption, no
 * multi-disk, no directory entries. It reads what it writes, and what it writes
 * is what `unzip` accepts (see backup-zip.test.ts).
 */

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const END_OF_CENTRAL_SIG = 0x06054b50
const METHOD_DEFLATE = 8
const METHOD_STORE = 0
/** Minimum version needed to extract: 2.0, the version that introduced DEFLATE. */
const VERSION_NEEDED = 20
/** General purpose bit 11: filename and comment are UTF-8. */
const UTF8_FLAG = 0x800

export interface ZipEntry {
  name: string
  data: Uint8Array
}

// ---------------------------------------------------------------------------
// CRC32. ZIP stores one per entry, and it is the only integrity check the
// format gives us. Table built once on first use.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  crcTable = table
  return table
}

export function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const localChunks: Uint8Array[] = []
  const centralChunks: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const raw = entry.data
    const crc = crc32(raw)

    // Storing beats deflating on tiny or incompressible payloads, and an empty
    // file must not become a 2-byte "compressed" one.
    let method = METHOD_DEFLATE
    let body: Uint8Array =
      raw.length === 0 ? new Uint8Array(0) : new Uint8Array(Bun.deflateSync(Uint8Array.from(raw)))
    if (raw.length === 0 || body.length >= raw.length) {
      method = METHOD_STORE
      body = raw
    }

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, LOCAL_HEADER_SIG, true)
    lv.setUint16(4, VERSION_NEEDED, true)
    lv.setUint16(6, UTF8_FLAG, true)
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true) // mod time, fixed so a backup is byte-identical for identical input
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra field length
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, CENTRAL_HEADER_SIG, true)
    cv.setUint16(4, VERSION_NEEDED, true)
    cv.setUint16(6, VERSION_NEEDED, true)
    cv.setUint16(8, UTF8_FLAG, true)
    cv.setUint16(10, method, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localChunks.push(local, body)
    centralChunks.push(central)
    offset += local.length + body.length
  }

  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, END_OF_CENTRAL_SIG, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true) // comment length

  return concat([...localChunks, ...centralChunks, end])
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read every entry, verifying each CRC.
 *
 * Walks the local headers rather than the central directory: this only ever
 * reads archives it wrote, the two agree, and a corrupt tail then still yields
 * the entries that survived rather than failing at the index.
 */
export function readZip(buf: Uint8Array): ZipEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.length < 22 || view.getUint32(0, true) !== LOCAL_HEADER_SIG) {
    throw new Error("Not a valid zip archive: missing the local file header signature.")
  }

  const decoder = new TextDecoder()
  const entries: ZipEntry[] = []
  let at = 0

  while (at + 30 <= buf.length && view.getUint32(at, true) === LOCAL_HEADER_SIG) {
    const method = view.getUint16(at + 8, true)
    const crc = view.getUint32(at + 14, true)
    const compressedSize = view.getUint32(at + 18, true)
    const uncompressedSize = view.getUint32(at + 22, true)
    const nameLength = view.getUint16(at + 26, true)
    const extraLength = view.getUint16(at + 28, true)

    const nameStart = at + 30
    const bodyStart = nameStart + nameLength + extraLength
    if (bodyStart + compressedSize > buf.length) {
      throw new Error("Zip archive is truncated: an entry runs past the end of the file.")
    }

    const name = decoder.decode(buf.subarray(nameStart, nameStart + nameLength))
    const body = buf.subarray(bodyStart, bodyStart + compressedSize)

    let data: Uint8Array
    if (method === METHOD_STORE) {
      data = new Uint8Array(body)
    } else if (method === METHOD_DEFLATE) {
      try {
        data = new Uint8Array(Bun.inflateSync(Uint8Array.from(body)))
      } catch (error) {
        throw new Error(`Zip entry "${name}" could not be decompressed: ${(error as Error).message}`)
      }
    } else {
      throw new Error(`Zip entry "${name}" uses unsupported compression method ${method}.`)
    }

    if (data.length !== uncompressedSize || crc32(data) !== crc) {
      throw new Error(`Zip entry "${name}" failed its checksum: the archive is corrupt.`)
    }

    entries.push({ name, data })
    at = bodyStart + compressedSize
  }

  if (entries.length === 0) {
    throw new Error("Not a valid zip archive: no entries could be read.")
  }
  return entries
}
