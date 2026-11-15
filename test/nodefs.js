// Test helpers: a folder on disk shaped like the browser's directory handle,
// and a file on disk shaped like a byte source.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export class NodeDir {
  constructor(dir) {
    this.dir = dir
  }
  async getDirectoryHandle(name, { create } = {}) {
    const p = path.join(this.dir, name)
    if (create) await fsp.mkdir(p, { recursive: true })
    else await fsp.access(p)
    return new NodeDir(p)
  }
  async getFileHandle(name, { create } = {}) {
    const p = path.join(this.dir, name)
    if (!create) await fsp.access(p)
    return {
      getFile: async () => ({ size: (await fsp.stat(p)).size }),
      createWritable: async () => {
        const fh = await fsp.open(p, 'w')
        return {
          write: async (chunk) => {
            await fh.write(chunk)
          },
          close: () => fh.close(),
          abort: () => fh.close(),
        }
      },
    }
  }
}

export class FileSource {
  constructor(file) {
    this.fd = fs.openSync(file, 'r')
    this.size = fs.fstatSync(this.fd).size
    this.label = file
  }
  async read(offset, length) {
    const n = Math.max(0, Math.min(length, this.size - offset))
    const buf = Buffer.alloc(n)
    let got = 0
    while (got < n) {
      const r = fs.readSync(this.fd, buf, got, n - got, offset + got)
      if (!r) break
      got += r
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, got)
  }
  async *stream(offset, length) {
    const end = Math.min(this.size, offset + length)
    for (let p = offset; p < end; p += 4 << 20) yield await this.read(p, Math.min(4 << 20, end - p))
  }
}
