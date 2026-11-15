// Splits a Windows image file (install.wim) into parts small enough for FAT32.
// Nothing is decompressed: each stored item is copied as it is into a part, and each
// part gets its own header and index. Windows Setup reads install.swm, install2.swm, ...
//
// This only plans the split. It returns, for every part, a list of pieces to write:
// either literal bytes, or a range of the original file.

const HEADER = 208
const ENTRY = 50
const FLAG_METADATA = 0x02
const FLAG_COMPRESSED = 0x04
const FLAG_SOLID = 0x10
const HDR_SPANNED = 0x08
const HDR_WRITE_IN_PROGRESS = 0x40

const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296
const u56 = (b, o) => u32(b, o) + (u32(b, o + 4) & 0xffffff) * 4294967296

function put32(b, o, v) {
  b[o] = v & 255
  b[o + 1] = (v >>> 8) & 255
  b[o + 2] = (v >>> 16) & 255
  b[o + 3] = (v >>> 24) & 255
}
function put64(b, o, v) {
  put32(b, o, v % 4294967296)
  put32(b, o + 4, Math.floor(v / 4294967296))
}
function putRes(b, o, size, flags, offset, original) {
  put64(b, o, size)
  b[o + 7] = flags
  put64(b, o + 8, offset)
  put64(b, o + 16, original)
}
const readRes = (b, o) => ({ size: u56(b, o), flags: b[o + 7], offset: u64(b, o + 8), original: u64(b, o + 16) })

/**
 * @param {(offset:number,length:number)=>Promise<Uint8Array>} read  reads from the WIM file
 * @param {number} wimSize
 * @param {number} partLimit  largest size of one part, in bytes
 * @returns {Promise<Array<{index:number,size:number,segments:Array}>>}
 */
export async function planWimSplit(read, wimSize, partLimit) {
  const header = await read(0, HEADER)
  const magic = String.fromCharCode(...header.subarray(0, 5))
  if (magic !== 'MSWIM') throw new Error('install.wim is not a Windows image file')
  const version = u32(header, 12)
  if (version !== 0x10d00) throw new Error('This kind of Windows image (ESD or solid) cannot be split in the browser')
  if (u16(header, 40) !== 1 || u16(header, 42) !== 1) throw new Error('This Windows image is already split')

  const table = readRes(header, 48)
  const xml = readRes(header, 72)
  if (table.size > 512 * 1024 * 1024 || xml.size > 64 * 1024 * 1024 || table.offset + table.size > wimSize || xml.offset + xml.size > wimSize) {
    throw new Error('install.wim is damaged or was not fully downloaded')
  }
  if (table.flags & FLAG_COMPRESSED) throw new Error('This Windows image has a compressed index, which is not supported')
  const tableBytes = await read(table.offset, table.size)
  const xmlBytes = await read(xml.offset, xml.size)

  const entries = []
  for (let o = 0; o + ENTRY <= tableBytes.length; o += ENTRY) {
    const r = readRes(tableBytes, o)
    if (r.flags & FLAG_SOLID) throw new Error('This kind of Windows image (solid) cannot be split in the browser')
    if (r.offset + r.size > wimSize) throw new Error('install.wim is damaged or was not fully downloaded')
    entries.push({ ...r, order: entries.length, raw: tableBytes.subarray(o, o + ENTRY) })
  }

  // Image descriptions ("metadata") all go in part 1. Everything else is packed in file order.
  const meta = entries.filter((e) => e.flags & FLAG_METADATA)
  const data = entries.filter((e) => !(e.flags & FLAG_METADATA)).sort((a, b) => a.offset - b.offset)

  const parts = [{ items: [...meta], used: HEADER + xmlBytes.length }]
  for (const e of meta) parts[0].used += e.size + ENTRY
  for (const e of data) {
    let part = parts[parts.length - 1]
    const hasData = part.items.some((i) => !(i.flags & FLAG_METADATA))
    if (part.used + e.size + ENTRY > partLimit && hasData) {
      part = { items: [], used: HEADER + xmlBytes.length }
      parts.push(part)
    }
    part.items.push(e)
    part.used += e.size + ENTRY
  }
  for (const p of parts) {
    if (p.used > partLimit) throw new Error('One item inside install.wim is too big for a FAT32 stick')
  }

  return parts.map((part, i) => {
    const number = i + 1
    // Data first (in file order), then image descriptions, as wimlib does.
    const ordered = [
      ...part.items.filter((e) => !(e.flags & FLAG_METADATA)),
      ...part.items.filter((e) => e.flags & FLAG_METADATA),
    ]
    let pos = HEADER
    const segments = []
    for (const e of ordered) {
      e.newOffset = pos
      pos += e.size
      if (!e.size) continue
      const side = !!(e.flags & FLAG_METADATA)
      const last = segments[segments.length - 1]
      if (last && !last.bytes && !side && !last.side && last.offset + last.length === e.offset) last.length += e.size
      else segments.push({ offset: e.offset, length: e.size, side })
    }
    // The index keeps the original order, because image 1 is the first description listed.
    const listed = [...part.items].sort((a, b) => a.order - b.order)
    const newTable = new Uint8Array(listed.length * ENTRY)
    listed.forEach((e, n) => {
      newTable.set(e.raw, n * ENTRY)
      putRes(newTable, n * ENTRY, e.size, e.flags, e.newOffset, e.original)
      newTable[n * ENTRY + 24] = number & 255
      newTable[n * ENTRY + 25] = number >>> 8
    })
    const tableOffset = pos
    const xmlOffset = tableOffset + newTable.length

    const h = header.slice(0, HEADER)
    put32(h, 16, (u32(h, 16) | HDR_SPANNED) & ~HDR_WRITE_IN_PROGRESS)
    h[40] = number & 255
    h[41] = number >>> 8
    h[42] = parts.length & 255
    h[43] = parts.length >>> 8
    putRes(h, 48, newTable.length, table.flags, tableOffset, newTable.length)
    putRes(h, 72, xmlBytes.length, xml.flags, xmlOffset, xmlBytes.length)
    h.fill(0, 96, 120) // boot description pointer: not used for install images
    put32(h, 120, 0)
    h.fill(0, 124, 148) // no integrity table

    return {
      index: number,
      size: xmlOffset + xmlBytes.length,
      segments: [{ bytes: h }, ...segments, { bytes: newTable }, { bytes: xmlBytes }],
    }
  })
}
