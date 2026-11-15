// Read-only UDF reader (the format Windows install discs use).
// Handles the plain layout Microsoft's ISOs have: one partition, no metadata partition.

const SECTOR = 2048
const MAX_DIR = 64 * 1024 * 1024 // no real folder listing is this big
const MAX_FILES = 200000
const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296
const tagId = (b) => u16(b, 0)

/**
 * @returns {Promise<null | {format:string, label:string, files:Array<{path:string,size:number,extents:Array,inline?:Uint8Array}>, dirs:string[]}>}
 */
export async function readUdf(source) {
  const anchor = await source.read(256 * SECTOR, SECTOR)
  if (anchor.length < SECTOR || tagId(anchor) !== 2) return null
  const vdsLen = u32(anchor, 16)
  const vdsLoc = u32(anchor, 20)

  let partStart = null
  let blockSize = SECTOR
  let fsd = null
  let label = ''
  for (let i = 0; i < Math.min(64, vdsLen / SECTOR); i++) {
    const d = await source.read((vdsLoc + i) * SECTOR, SECTOR)
    const id = tagId(d)
    if (id === 8) break
    if (id === 5 && partStart === null) partStart = u32(d, 188)
    if (id === 6) {
      blockSize = u32(d, 212)
      fsd = { length: u32(d, 248) & 0x3fffffff, lbn: u32(d, 252) }
      label = dstring(d.subarray(84, 212))
      // Only "type 1" partition maps are supported (a direct mapping).
      const maps = u32(d, 268)
      if (maps > 0 && d[440] !== 1) throw new Error('This UDF disc uses a layout mkstick cannot read')
    }
  }
  if (partStart === null || !fsd) return null
  const at = (lbn) => (partStart + lbn) * blockSize

  const fsdData = await source.read(at(fsd.lbn), Math.max(fsd.length, 512))
  if (tagId(fsdData) !== 256) return null
  const rootLbn = u32(fsdData, 404)

  /** Reads a File Entry and returns its type and where its data is. */
  async function entry(lbn) {
    const fe = await source.read(at(lbn), blockSize)
    const id = tagId(fe)
    if (id !== 261 && id !== 266) throw new Error('Damaged UDF file entry')
    const ext = id === 266
    const fileType = fe[27]
    const adType = u16(fe, 34) & 7
    const size = u64(fe, 56)
    const lEa = u32(fe, ext ? 208 : 168)
    const lAd = u32(fe, ext ? 212 : 172)
    const adStart = (ext ? 216 : 176) + lEa
    if (adType === 3) return { fileType, size: Math.min(size, blockSize), extents: [], inline: fe.slice(adStart, adStart + Math.min(size, blockSize)) }
    const extents = []
    let ads = fe.subarray(adStart, adStart + lAd)
    const step = adType === 0 ? 8 : 16
    if (adType > 1) throw new Error('This UDF disc uses a layout mkstick cannot read')
    for (let guard = 0; guard < 10000; guard++) {
      let next = null
      for (let o = 0; o + step <= ads.length; o += step) {
        const raw = u32(ads, o)
        const length = raw & 0x3fffffff
        const kind = raw >>> 30
        const pos = u32(ads, o + 4)
        if (length === 0) break
        if (kind === 3) {
          next = { pos, length }
          break
        }
        extents.push(kind === 0 ? { offset: at(pos), length } : { hole: true, length })
      }
      if (!next) break
      // More allocation descriptors live in another block.
      const aed = await source.read(at(next.pos), next.length)
      if (tagId(aed) !== 258) break
      ads = aed.subarray(24, 24 + u32(aed, 20))
    }
    // The last extent is rounded up to a block; trim to the real size.
    let left = size
    const trimmed = []
    for (const e of extents) {
      if (left <= 0) break
      const length = Math.min(e.length, left)
      trimmed.push({ ...e, length })
      left -= length
    }
    return { fileType, size, extents: trimmed }
  }

  async function readAll(e) {
    if (e.inline) return e.inline
    const out = new Uint8Array(e.size)
    let o = 0
    for (const x of e.extents) {
      if (!x.hole) out.set(await source.read(x.offset, x.length), o)
      o += x.length
    }
    return out
  }

  const files = []
  const dirs = []
  const seen = new Set()
  const queue = [{ lbn: rootLbn, path: '' }]
  while (queue.length) {
    const dir = queue.shift()
    if (seen.has(dir.lbn)) continue
    seen.add(dir.lbn)
    const dirEntry = await entry(dir.lbn)
    if (dirEntry.size > MAX_DIR || files.length > MAX_FILES || dirs.length > MAX_FILES) throw new Error('This disc image is damaged or too unusual to read')
    const data = await readAll(dirEntry)
    let o = 0
    while (o + 38 <= data.length) {
      if (tagId(data.subarray(o)) !== 257) break
      const chars = data[o + 18]
      const lFi = data[o + 19]
      const icbLbn = u32(data, o + 24)
      const lIu = u16(data, o + 36)
      const nameBytes = data.subarray(o + 38 + lIu, o + 38 + lIu + lFi)
      o += (38 + lIu + lFi + 3) & ~3
      if (chars & 0x0c) continue // deleted, or the parent folder
      const name = udfName(nameBytes)
      const path = dir.path ? `${dir.path}/${name}` : name
      if (chars & 0x02) {
        dirs.push(path)
        queue.push({ lbn: icbLbn, path })
      } else {
        const e = await entry(icbLbn)
        files.push({ path, size: e.size, extents: e.extents, inline: e.inline })
      }
    }
  }
  return { format: 'UDF', label, files, dirs }
}

function udfName(b) {
  if (!b.length) return ''
  if (b[0] === 16) {
    let s = ''
    for (let i = 1; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
    return s
  }
  return String.fromCharCode(...b.subarray(1))
}

function dstring(b) {
  const len = b[b.length - 1]
  return len > 1 ? udfName(b.subarray(0, len)).trim() : ''
}
