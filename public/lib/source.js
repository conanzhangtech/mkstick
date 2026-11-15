// Byte sources: a local file the user picked, or a file on a mirror read in pieces.
// Every source has `size`, `read(offset, length)` and `stream(offset, length)`.

const CHUNK = 4 * 1024 * 1024

/** A local file (a Blob or File). Nothing is uploaded; the browser reads slices. */
export class BlobSource {
  constructor(blob, label) {
    this.blob = blob
    this.size = blob.size
    this.label = label || blob.name || 'file'
  }
  async read(offset, length) {
    const end = Math.min(this.size, offset + length)
    if (end <= offset) return new Uint8Array(0)
    return new Uint8Array(await this.blob.slice(offset, end).arrayBuffer())
  }
  async *stream(offset, length) {
    const end = Math.min(this.size, offset + length)
    for (let p = offset; p < end; p += CHUNK) yield await this.read(p, Math.min(CHUNK, end - p))
  }
}

/** A file on a web server that supports Range requests. */
export class HttpSource {
  constructor(url, size, label, fetchImpl) {
    this.url = url
    this.size = size
    this.label = label || url
    this.fetch = fetchImpl || ((...a) => fetch(...a))
  }
  static async open(url, label, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a))
    for (let attempt = 0; ; attempt++) {
      const res = await f(url, { headers: { Range: 'bytes=0-0' } })
      if (res.status === 206) {
        await res.arrayBuffer()
        const total = /\/(\d+)$/.exec(res.headers.get('content-range') || '')?.[1]
        if (!total) throw new Error('The server did not say how big the file is')
        return new HttpSource(url, Number(total), label, fetchImpl)
      }
      await res.body?.cancel() // never read a whole image by accident
      if (attempt >= 3) throw new Error(res.status === 200 ? 'The server does not allow partial downloads' : `The server answered ${res.status}`)
      await sleep(600 * (attempt + 1))
    }
  }
  async read(offset, length) {
    const end = Math.min(this.size, offset + length)
    if (end <= offset) return new Uint8Array(0)
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetch(this.url, { headers: { Range: `bytes=${offset}-${end - 1}` } })
        if (res.status !== 206) {
          await res.body?.cancel()
          throw new Error(`Server answered ${res.status}`)
        }
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.length !== end - offset) throw new Error('Short read')
        return buf
      } catch (e) {
        if (attempt >= 4) throw e
        await sleep(400 * 2 ** attempt)
      }
    }
  }
  /**
   * mkstick reads an image from start to end, so one download is kept open and each call
   * carries on from where the last one stopped. A call for a different place starts a new
   * download. If the connection drops, it restarts from the same byte.
   */
  async *stream(offset, length) {
    const end = Math.min(this.size, offset + length)
    let pos = offset
    let failures = 0
    while (pos < end) {
      try {
        if (!this.live || this.live.pos !== pos) {
          await this.close()
          const res = await this.fetch(this.url, { headers: { Range: `bytes=${pos}-${this.size - 1}` } })
          if (res.status !== 206) {
            await res.body?.cancel()
            throw new Error(`Server answered ${res.status}`)
          }
          this.live = { reader: res.body.getReader(), pos, rest: null }
        }
        const live = this.live
        let chunk = live.rest
        live.rest = null
        if (!chunk) {
          const { done, value } = await live.reader.read()
          if (done) throw new Error('Connection ended early')
          chunk = value
        }
        const want = end - pos
        if (chunk.length > want) {
          live.rest = chunk.subarray(want)
          chunk = chunk.subarray(0, want)
        }
        pos += chunk.length
        live.pos = pos
        failures = 0
        yield chunk
      } catch (e) {
        await this.close()
        if (++failures > 5) throw e
        await sleep(500 * failures)
      }
    }
  }
  async close() {
    const live = this.live
    this.live = null
    if (live) {
      try {
        await live.reader.cancel()
      } catch {}
    }
  }
}

/** Remembers recent small reads, so reading a folder listing does not make many requests. */
export class CachedSource {
  constructor(inner, blockSize = 256 * 1024, maxBlocks = 64) {
    this.inner = inner
    this.size = inner.size
    this.label = inner.label
    this.blockSize = blockSize
    this.maxBlocks = maxBlocks
    this.blocks = new Map()
  }
  async block(n) {
    if (this.blocks.has(n)) {
      const b = this.blocks.get(n)
      this.blocks.delete(n)
      this.blocks.set(n, b)
      return b
    }
    const b = await this.inner.read(n * this.blockSize, this.blockSize)
    this.blocks.set(n, b)
    if (this.blocks.size > this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value)
    return b
  }
  async read(offset, length) {
    if (length > this.blockSize * 4) return this.inner.read(offset, length)
    const end = Math.min(this.size, offset + length)
    const out = new Uint8Array(Math.max(0, end - offset))
    let o = offset
    while (o < end) {
      const n = Math.floor(o / this.blockSize)
      const b = await this.block(n)
      const from = o - n * this.blockSize
      const take = Math.min(b.length - from, end - o)
      if (take <= 0) break
      out.set(b.subarray(from, from + take), o - offset)
      o += take
    }
    return out
  }
  stream(offset, length) {
    return this.inner.stream(offset, length)
  }
  close() {
    return this.inner.close?.()
  }
}

/** Reads a list of {offset,length,hole} pieces of a source as one stream. */
export async function* streamExtents(source, extents) {
  for (const e of extents) {
    if (e.hole) {
      for (let left = e.length; left > 0; left -= CHUNK) yield new Uint8Array(Math.min(CHUNK, left))
    } else {
      yield* source.stream(e.offset, e.length)
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
