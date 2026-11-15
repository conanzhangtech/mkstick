// Draws the QR codes for the donation addresses as static SVG files in public/qr/, and
// reads each one back to prove it holds exactly the address in index.html.
//
//   npm install --no-save qrcode jsqr
//   node tools/make-qr.mjs
//
// Nothing here runs on the site. The page only shows the finished SVG files.
import fs from 'node:fs'
import QRCode from 'qrcode'
import jsQR from 'jsqr'

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const address = (id) => {
  const found = new RegExp(`id="${id}">([^<]+)<`).exec(html)?.[1]
  if (!found) throw new Error(`No address with id ${id} in index.html`)
  return found.trim()
}
const CODES = [
  { file: 'usdt-erc20.svg', text: address('addr-erc20'), label: 'USDT on Ethereum (ERC-20)' },
  { file: 'usdt-trc20.svg', text: address('addr-trc20'), label: 'USDT on Tron (TRC-20)' },
]
const QUIET = 4 // blank modules around the code, as the QR standard asks

for (const code of CODES) {
  const qr = QRCode.create(code.text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const dark = (x, y) => qr.modules.data[y * n + x] === 1
  const size = n + QUIET * 2

  // The SVG: one path of 1 x 1 squares on a white background.
  let path = ''
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (dark(x, y)) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code: ${code.label}"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#10231c" d="${path}"/></svg>\n`

  // Read it back: paint the same squares as pixels and decode them.
  const scale = 8
  const px = size * scale
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!dark(x, y)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + QUIET) * scale + dy) * px + (x + QUIET) * scale + dx) * 4
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
        }
      }
    }
  }
  const read = jsQR(rgba, px, px)?.data
  if (read !== code.text) throw new Error(`${code.file} does not read back as its address (got ${read})`)

  fs.writeFileSync(new URL(`../public/qr/${code.file}`, import.meta.url), svg)
  console.log(`${code.file}: ${n} x ${n} modules, reads back as ${read}`)
}
