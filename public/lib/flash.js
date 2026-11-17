// Works out what to write to the stick, then writes it.
// The stick is any object shaped like the browser's FileSystemDirectoryHandle.

import { patchFor } from './patches.js'
import { readIso9660 } from './iso9660.js'
import { readUdf } from './udf.js'
import { planWimSplit } from './wim.js'
import { CachedSource, streamExtents } from './source.js'

export const FAT32_MAX = 4294967295 // largest file FAT32 can hold
export const WIM_PART = 3800 * 1024 * 1024
const BAD_NAME = /[<>:"\\|?*\u0000-\u001f]/
// A name from a disc image is never trusted: no empty parts, no "." or "..", no characters FAT32 forbids.
const badPath = (path) => path.split('/').some((part) => !part || part.length > 255 || BAD_NAME.test(part) || part.endsWith('.') || part.endsWith(' '))

/** Cuts a byte range out of a list of extents. */
function sliceExtents(extents, start, length) {
  const out = []
  let pos = 0
  for (const e of extents) {
    const from = Math.max(start, pos)
    const to = Math.min(start + length, pos + e.length)
    if (to > from) out.push(e.hole ? { hole: true, length: to - from } : { offset: e.offset + (from - pos), length: to - from })
    pos += e.length
    if (pos >= start + length) break
  }
  return out
}

async function readFromExtents(source, extents, start, length) {
  const out = new Uint8Array(length)
  let o = 0
  for (const e of sliceExtents(extents, start, length)) {
    if (!e.hole) out.set(await source.read(e.offset, e.length), o)
    o += e.length
  }
  return out
}

/**
 * Reads the disc image and decides what goes on the stick.
 * @returns {Promise<{kind:string,format:string,label:string,outputs:Array,totalBytes:number,skipped:string[],notes:string[]}>}
 */
export async function buildPlan(rawSource, { wimPart = WIM_PART, patch = null } = {}) {
  const source = new CachedSource(rawSource, 2 * 1024 * 1024, 32)
  // Windows discs carry both formats, and the ISO 9660 side only holds a readme. Try UDF first.
  let image = await readUdf(source)
  if (image && !image.files.length) image = null
  if (!image) image = await readIso9660(source)
  if (!image) throw new Error('This file is not a disc image mkstick can read')

  const lower = new Map(image.files.map((f) => [f.path.toLowerCase(), f]))
  const isWindows = lower.has('sources/install.wim') || lower.has('sources/install.esd') || lower.has('sources/boot.wim')
  const hasEfi = [...lower.keys()].some((p) => /^efi\/boot\/boot(x64|aa64|ia32)\.efi$/.test(p))
  const notes = []
  const skipped = []
  const outputs = []
  if (!hasEfi) throw new Error('This disc image has no UEFI boot files, so a stick made from it would not start')

  // FAT32 has no symbolic links. Copy what each link points to, when that is a file or a small folder.
  const dirSet = new Set(image.dirs.map((d) => d.toLowerCase()))
  let linked = 0
  for (const l of image.links || []) {
    const base = l.target[0] === '/' ? [] : l.path.split('/').slice(0, -1)
    for (const part of l.target) {
      if (part === '/' || part === '.') continue
      if (part === '..') base.pop()
      else base.push(...part.split('/').filter(Boolean))
    }
    const target = base.join('/')
    const key = target.toLowerCase()
    if (!target || (l.path + '/').toLowerCase().startsWith(key + '/')) continue // points at itself or a parent
    if (lower.has(key)) {
      image.files.push({ ...lower.get(key), path: l.path })
      linked++
    } else if (dirSet.has(key)) {
      const inside = image.files.filter((f) => f.path.toLowerCase().startsWith(key + '/'))
      if (inside.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024) continue
      for (const f of inside) image.files.push({ ...f, path: l.path + f.path.slice(target.length) })
      linked++
    }
  }
  if (linked) notes.push(`${linked} shortcuts inside the image were copied as real files`)

  const patchWith = patch ? { ...patch, label: image.label } : null
  const windows = isWindows ? await windowsDetails(source, lower.get('sources/install.wim') || lower.get('sources/install.esd')) : null

  const seenNames = new Set()
  for (const f of image.files) {
    const key = f.path.toLowerCase()
    if (badPath(f.path)) {
      skipped.push(f.path)
      continue
    }
    if (seenNames.has(key)) {
      skipped.push(f.path)
      continue
    }
    seenNames.add(key)

    if (f.size > FAT32_MAX) {
      if (key !== 'sources/install.wim') {
        throw new Error(`${f.path} is larger than 4 GB and cannot be stored on a FAT32 stick`)
      }
      const parts = await planWimSplit((o, n) => readFromExtents(source, f.extents, o, n), f.size, wimPart)
      for (const part of parts) {
        const segments = []
        for (const s of part.segments) {
          if (s.bytes) segments.push(s)
          else for (const e of sliceExtents(f.extents, s.offset, s.length)) segments.push({ ...e, side: s.side })
        }
        outputs.push({
          path: `sources/install${part.index === 1 ? '' : part.index}.swm`,
          size: part.size,
          segments,
        })
      }
      notes.push(`install.wim (${gb(f.size)}) is split into ${parts.length} parts`)
      continue
    }
    const change = f.size < 200000 && !f.inline ? patchFor(patchWith, f.path) : null
    if (change) {
      const before = new TextDecoder().decode(await readFromExtents(source, f.extents, 0, f.size))
      const after = change(before)
      if (after !== before) {
        const bytes = new TextEncoder().encode(after)
        outputs.push({ path: f.path, size: bytes.length, segments: [{ bytes }] })
        if (!notes.some((n) => n.includes('boot menu'))) notes.push('the boot menu was changed so that the installer finds itself on a stick')
        continue
      }
    }
    outputs.push({
      path: f.path,
      size: f.size,
      segments: f.inline ? [{ bytes: f.inline }] : f.extents.map((e) => ({ ...e })),
    })
  }

  // Write in the order the data sits in the image, so it is read once from start to end.
  const firstOffset = (o) => o.segments.find((s) => !s.bytes && !s.hole && !s.side)?.offset ?? -1
  outputs.sort((a, b) => firstOffset(a) - firstOffset(b))

  return {
    kind: isWindows ? 'windows' : 'linux',
    windows,
    format: image.format,
    label: image.label,
    // Some installers only find themselves on a stick that carries the disc's own name.
    needsName: patch?.name === 'archiso' && /^[A-Za-z0-9_-]{1,11}$/.test(image.label) ? image.label : null,
    outputs,
    dirs: image.dirs.filter((d) => !badPath(d)),
    totalBytes: outputs.reduce((n, o) => n + o.size, 0),
    skipped,
    notes,
  }
}

/**
 * Reads what a Windows image says about itself: the processor type it is built for and the
 * editions inside. This comes from the description stored in install.wim.
 */
async function windowsDetails(source, wim) {
  try {
    if (!wim) return null
    const header = await readFromExtents(source, wim.extents, 0, 208)
    if (String.fromCharCode(...header.subarray(0, 5)) !== 'MSWIM') return null
    const u32 = (o) => (header[o] | (header[o + 1] << 8) | (header[o + 2] << 16) | (header[o + 3] << 24)) >>> 0
    const size = u32(72) + (u32(76) & 0xffffff) * 4294967296
    const offset = u32(80) + u32(84) * 4294967296
    if (!size || size > 8 * 1024 * 1024 || offset + size > wim.size) return null
    const xml = new TextDecoder('utf-16le').decode(await readFromExtents(source, wim.extents, offset, size))
    const code = /<ARCH>(\d+)<\/ARCH>/.exec(xml)?.[1]
    const arch = { 0: '32-bit', 9: '64-bit, for Intel and AMD processors', 12: '64-bit, for Arm processors' }[code] || null
    const editions = [...xml.matchAll(/<IMAGE [^>]*>[\s\S]*?<NAME>([^<]{1,80})<\/NAME>/g)].map((m) => m[1])
    return { arch, editions }
  } catch {
    return null
  }
}

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`

async function dirFor(root, path, cache) {
  const parts = path.split('/').slice(0, -1)
  let dir = root
  let key = ''
  for (const p of parts) {
    key += '/' + p.toLowerCase()
    if (!cache.has(key)) cache.set(key, await dir.getDirectoryHandle(p, { create: true }))
    dir = cache.get(key)
  }
  return dir
}

async function existingSize(dir, name) {
  try {
    const fh = await dir.getFileHandle(name)
    return (await fh.getFile()).size
  } catch {
    return -1
  }
}

/**
 * Writes the plan to the stick.
 * @param hasher  optional {update(chunk)}; fed the whole image in order, for a checksum
 * @returns {Promise<{written:number, skippedExisting:number, hashed:boolean}>}
 */
export async function writePlan(rawSource, plan, root, { onProgress, signal, hasher, resume = true } = {}) {
  const dirs = new Map()
  let done = 0
  let skippedExisting = 0
  let hashPos = 0
  let hashing = !!hasher
  const report = (path) => onProgress?.({ done, total: plan.totalBytes, path })
  const check = () => {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
  }

  // Feeds the checksum with image bytes in order; bytes between files are read just for this.
  async function hashUpTo(offset) {
    if (!hashing || offset <= hashPos) return
    for await (const chunk of rawSource.stream(hashPos, offset - hashPos)) {
      check()
      hasher.update(chunk)
      hashPos += chunk.length
    }
  }

  // Some small files appear more than once (copies of shortcuts). Keep their bytes from the
  // first pass, so the copies do not need another download.
  const SMALL = 8 * 1024 * 1024
  const keyOf = (seg) => `${seg.offset}:${seg.length}`
  const uses = new Map()
  for (const out of plan.outputs) {
    for (const seg of out.segments) if (!seg.bytes && !seg.hole && seg.length <= SMALL) uses.set(keyOf(seg), (uses.get(keyOf(seg)) || 0) + 1)
  }
  const kept = new Map()
  for (const d of plan.dirs || []) await dirFor(root, `${d}/-`, dirs) // empty folders too

  for (const out of plan.outputs) {
    check()
    const dir = await dirFor(root, out.path, dirs)
    const name = out.path.split('/').pop()
    if (resume && (await existingSize(dir, name)) === out.size) {
      done += out.size
      skippedExisting++
      hashing = false // the image is no longer read from start to end
      report(out.path)
      continue
    }
    const fh = await dir.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    // Network data arrives in small pieces. Group them, because each write to a stick has a fixed cost.
    let pending = []
    let pendingSize = 0
    const flush = async () => {
      if (!pendingSize) return
      let block = pending[0]
      if (pending.length > 1) {
        block = new Uint8Array(pendingSize)
        let o = 0
        for (const c of pending) (block.set(c, o), (o += c.length))
      }
      pending = []
      pendingSize = 0
      await w.write(block)
    }
    const put = async (chunk) => {
      pending.push(chunk)
      pendingSize += chunk.length
      if (pendingSize >= 2 * 1024 * 1024) await flush()
    }
    try {
      for (const seg of out.segments) {
        if (seg.bytes) {
          await put(seg.bytes)
          done += seg.bytes.length
          continue
        }
        const inOrder = hashing && !seg.side && !seg.hole && seg.offset >= hashPos
        if (inOrder) await hashUpTo(seg.offset)
        // Small out-of-order pieces are fetched on their own, so the main download stays open.
        const oneShot = !inOrder && !seg.hole && seg.length <= SMALL
        const key = keyOf(seg)
        const keep = inOrder && uses.get(key) > 1 ? [] : null
        const chunks = oneShot ? [kept.get(key) || (await rawSource.read(seg.offset, seg.length))] : streamExtents(rawSource, [seg])
        for await (const chunk of chunks) {
          check()
          if (keep) keep.push(chunk.slice())
          if (inOrder) {
            hasher.update(chunk)
            hashPos += chunk.length
          }
          await put(chunk)
          done += chunk.length
          report(out.path)
        }
        if (keep) {
          const all = new Uint8Array(seg.length)
          let o = 0
          for (const c of keep) (all.set(c, o), (o += c.length))
          kept.set(key, all)
        }
      }
      await flush()
      await w.close()
    } catch (e) {
      try {
        await w.abort()
      } catch {}
      throw e
    }
    report(out.path)
  }
  if (hashing) await hashUpTo(rawSource.size)
  await rawSource.close?.()
  return { written: plan.outputs.length - skippedExisting, skippedExisting, hashed: hashing && hashPos === rawSource.size }
}

/** Checks every file on the stick exists with the right size. */
export async function verifySizes(plan, root) {
  const dirs = new Map()
  const wrong = []
  for (const out of plan.outputs) {
    const dir = await dirFor(root, out.path, dirs)
    if ((await existingSize(dir, out.path.split('/').pop())) !== out.size) wrong.push(out.path)
  }
  return wrong
}
