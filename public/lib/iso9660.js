// Read-only ISO 9660 reader (the format Linux install discs use).
// Uses Joliet names when the disc has them, then Rock Ridge names, then plain names.

const SECTOR = 2048
const MAX_DIR = 64 * 1024 * 1024 // no real folder listing is this big
const MAX_FILES = 200000
const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n))

/**
 * @returns {Promise<null | {format:string, label:string, files:Array<{path:string,size:number,extents:Array}>, dirs:string[]}>}
 */
export async function readIso9660(source) {
  let primary = null
  let joliet = null
  for (let s = 16; s < 64; s++) {
    const d = await source.read(s * SECTOR, SECTOR)
    if (d.length < SECTOR || ascii(d, 1, 5) !== 'CD001') break
    if (d[0] === 255) break
    if (d[0] === 1) primary = d
    if (d[0] === 2) {
      const esc = ascii(d, 88, 3)
      if (esc === '%/@' || esc === '%/C' || esc === '%/E') joliet = d
    }
  }
  if (!primary) return null

  // Rock Ridge keeps full-length names; Joliet cuts them at 64 characters. Prefer Rock Ridge.
  const pRoot = primary.subarray(156, 190)
  const rootDir = await source.read(u32(pRoot, 2) * u16(primary, 128), Math.min(u32(pRoot, 10), SECTOR))
  const dot = rootDir.subarray(0, rootDir[0])
  const dotUse = ascii(dot, 34, Math.max(0, dot.length - 34))
  const hasRockRidge = /SP|RR|PX/.test(dotUse)
  const useJoliet = !!joliet && !hasRockRidge
  const vd = useJoliet ? joliet : primary
  const label = useJoliet ? utf16be(vd.subarray(40, 72)).trim() : ascii(primary, 40, 32).trim()
  const blockSize = u16(vd, 128)
  const root = vd.subarray(156, 190)

  const files = []
  const dirs = []
  const links = []
  const seen = new Set()
  const queue = [{ lba: u32(root, 2), size: u32(root, 10), path: '' }]
  while (queue.length) {
    const dir = queue.shift()
    if (seen.has(dir.lba)) continue
    seen.add(dir.lba)
    if (dir.size > MAX_DIR || files.length > MAX_FILES || dirs.length > MAX_FILES) throw new Error('This disc image is damaged or too unusual to read')
    const data = await source.read(dir.lba * blockSize, dir.size)
    let pending = null // a file split over several records
    let o = 0
    while (o < data.length) {
      const len = data[o]
      if (len === 0) {
        // Records never cross a sector; skip to the next one.
        o = (Math.floor(o / blockSize) + 1) * blockSize
        continue
      }
      const rec = data.subarray(o, o + len)
      o += len
      const flags = rec[25]
      const nameLen = rec[32]
      const raw = rec.subarray(33, 33 + nameLen)
      if (nameLen === 1 && (raw[0] === 0 || raw[0] === 1)) continue // "." and ".."
      let name
      if (useJoliet) {
        name = utf16be(raw).replace(/;\d+$/, '')
      } else {
        const sysUse = rec.subarray(33 + nameLen + ((nameLen + 1) % 2))
        const rr = rockRidge(sysUse)
        // Long names continue in another block ("CE").
        for (let hops = 0; rr.ce && hops < 8; hops++) {
          const more = await source.read(rr.ce.block * blockSize + rr.ce.offset, rr.ce.length)
          rr.ce = null
          const next = rockRidge(more)
          rr.name += next.name
          rr.skip = rr.skip || next.skip
          rr.link = rr.link.concat(next.link)
          rr.ce = next.ce
        }
        if (rr.link.length && rr.name) links.push({ path: dir.path ? `${dir.path}/${rr.name}` : rr.name, target: rr.link })
        if (rr.skip) continue
        name = rr.name || ascii(raw, 0, nameLen).replace(/;\d+$/, '').replace(/\.$/, '').toLowerCase()
      }
      const path = dir.path ? `${dir.path}/${name}` : name
      const extent = { offset: (u32(rec, 2) + rec[1]) * blockSize, length: u32(rec, 10) }
      if (flags & 2) {
        dirs.push(path)
        queue.push({ lba: u32(rec, 2) + rec[1], size: u32(rec, 10), path })
        continue
      }
      if (pending && pending.path === path) {
        pending.extents.push(extent)
        pending.size += extent.length
      } else {
        pending = { path, size: extent.length, extents: [extent] }
        files.push(pending)
      }
      if (!(flags & 0x80)) pending = null // 0x80 means more pieces follow
    }
  }
  for (const f of files) f.extents = f.extents.filter((e) => e.length > 0)
  return { format: useJoliet ? 'ISO 9660 (Joliet)' : hasRockRidge ? 'ISO 9660 (Rock Ridge)' : 'ISO 9660', label, files, dirs, links }
}

function rockRidge(b) {
  let name = ''
  let skip = false
  let ce = null
  const link = []
  let o = 0
  while (o + 4 <= b.length) {
    const sig = ascii(b, o, 2)
    const len = b[o + 2]
    if (len < 4) break
    if (sig === 'NM') name += new TextDecoder().decode(b.subarray(o + 5, o + len))
    if (sig === 'RE') skip = true // moved folders
    if (sig === 'SL') {
      // A symbolic link. FAT32 cannot store one, so the caller copies what it points to.
      skip = true
      let c = o + 5
      while (c + 2 <= o + len) {
        const f = b[c]
        const n = b[c + 1]
        if (f & 2) link.push('.')
        else if (f & 4) link.push('..')
        else if (f & 8) link.push('/')
        else link.push(new TextDecoder().decode(b.subarray(c + 2, c + 2 + n)))
        c += 2 + n
      }
    }
    if (sig === 'CE' && len >= 28) ce = { block: u32(b, o + 4), offset: u32(b, o + 12), length: u32(b, o + 20) }
    o += len
  }
  return { name, skip, ce, link }
}

function utf16be(b) {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
  return s.replace(/\0+$/, '')
}
