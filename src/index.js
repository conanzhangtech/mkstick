// mkstick's Worker. It stores no disc images.
//   /api/catalogue          what can be installed, with current file names and checksums
//   /api/windows/languages  the languages a direct link is held for
//   /api/windows/link       an official Microsoft download link (the file comes from Microsoft)
//   /api/windows/links      POST, with a secret: the scheduled job hands over fresh links
//   /mirror/<id>/<path>     passes a piece of a Linux image through from its publisher's server
// Everything else is the static page in public/.

// Windows versions mkstick lists. The links themselves are fetched by the job in jobs/ and
// stored here, because Microsoft rejects link requests that come from Cloudflare's network.
const WINDOWS_PRODUCTS = {
  win11: { name: 'Windows 11', page: 'windows11', archs: ['x64', 'arm64'] },
  win10: { name: 'Windows 10', page: 'Windows10ISO', archs: ['x64'] },
}
const LINK_LIFE = 23 * 3600 // seconds; Microsoft's links last about 24 hours
const LANG = /^[A-Za-z ()-]{2,40}$/

// Only these servers can be reached through /mirror/.
const MIRRORS = {
  ubuntu: { base: 'https://releases.ubuntu.com/', host: 'releases.ubuntu.com' },
  debian: { base: 'https://cdimage.debian.org/', host: 'cdimage.debian.org' },
  mint: { base: 'https://mirrors.edge.kernel.org/linuxmint/stable/', host: 'mirrors.edge.kernel.org' },
  arch: { base: 'https://geo.mirror.pkgbuild.com/', host: 'geo.mirror.pkgbuild.com' },
  alpine: { base: 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/', host: 'dl-cdn.alpinelinux.org' },
  rocky: { base: 'https://dl.rockylinux.org/pub/rocky/', host: 'dl.rockylinux.org' },
  alma: { base: 'https://repo.almalinux.org/almalinux/', host: 'repo.almalinux.org' },
}

// What each Linux entry is and where its checksum lives. Fields:
//   dir      the folder on the publisher's server (or, with pickDir, a folder of version folders)
//   match    the image's file name
//   sums     the checksum file (default SHA256SUMS); perFile means "<image>.sha256" next to the image
//   patch    a boot-menu fix the page applies while writing (see public/lib/patches.js)
//   repo     for installers that fetch their packages online: the publisher's package tree
const LINUX = [
  { id: 'ubuntu-2604-desktop', name: 'Ubuntu Desktop 26.04 LTS', mirror: 'ubuntu', dir: '26.04/', match: /^ubuntu-[\d.]+-desktop-amd64\.iso$/, stick: 8 },
  { id: 'ubuntu-2604-server', name: 'Ubuntu Server 26.04 LTS', mirror: 'ubuntu', dir: '26.04/', match: /^ubuntu-[\d.]+-live-server-amd64\.iso$/, stick: 8 },
  { id: 'ubuntu-desktop', name: 'Ubuntu Desktop 24.04 LTS', mirror: 'ubuntu', dir: '24.04/', match: /^ubuntu-[\d.]+-desktop-amd64\.iso$/, stick: 8 },
  { id: 'ubuntu-server', name: 'Ubuntu Server 24.04 LTS', mirror: 'ubuntu', dir: '24.04/', match: /^ubuntu-[\d.]+-live-server-amd64\.iso$/, stick: 8 },
  { id: 'debian', name: 'Debian (network installer)', mirror: 'debian', dir: 'debian-cd/current/amd64/iso-cd/', match: /^debian-[\d.]+-amd64-netinst\.iso$/, stick: 2 },
  { id: 'debian-live', name: 'Debian Live (GNOME)', mirror: 'debian', dir: 'debian-cd/current-live/amd64/iso-hybrid/', match: /^debian-live-[\d.]+-amd64-gnome\.iso$/, stick: 8 },
  { id: 'mint', name: 'Linux Mint (Cinnamon)', mirror: 'mint', pickDir: true, sums: 'sha256sum.txt', match: /^linuxmint-[\d.]+-cinnamon-64bit\.iso$/, stick: 8 },
  { id: 'arch', name: 'Arch Linux', mirror: 'arch', dir: 'iso/latest/', sums: 'sha256sums.txt', match: /^archlinux-\d{4}\.\d{2}\.\d{2}-x86_64\.iso$/, stick: 4, patch: 'archiso' },
  { id: 'alpine', name: 'Alpine Linux (standard)', mirror: 'alpine', dir: '', perFile: true, match: /^alpine-standard-\d+\.\d+\.\d+-x86_64\.iso$/, stick: 1 },
  { id: 'rocky-10', name: 'Rocky Linux 10 (network installer)', mirror: 'rocky', dir: '10/isos/x86_64/', sums: 'CHECKSUM', match: /^Rocky-[\d.]+-\d+\.\d+-x86_64-boot\.iso$/, stick: 2, patch: 'anaconda', repo: 'https://dl.rockylinux.org/pub/rocky/10/BaseOS/x86_64/os/' },
  { id: 'rocky-9', name: 'Rocky Linux 9 (network installer)', mirror: 'rocky', dir: '9/isos/x86_64/', sums: 'CHECKSUM', match: /^Rocky-[\d.]+-\d+\.\d+-x86_64-boot\.iso$/, stick: 2, patch: 'anaconda', repo: 'https://dl.rockylinux.org/pub/rocky/9/BaseOS/x86_64/os/' },
  { id: 'alma-10', name: 'AlmaLinux 10 (network installer)', mirror: 'alma', dir: '10/isos/x86_64/', sums: 'CHECKSUM', match: /^AlmaLinux-[\d.]+-x86_64-boot\.iso$/, stick: 2, patch: 'anaconda', repo: 'https://repo.almalinux.org/almalinux/10/BaseOS/x86_64/os/' },
  { id: 'alma-9', name: 'AlmaLinux 9 (network installer)', mirror: 'alma', dir: '9/isos/x86_64/', sums: 'CHECKSUM', match: /^AlmaLinux-[\d.]+-x86_64-boot\.iso$/, stick: 2, patch: 'anaconda', repo: 'https://repo.almalinux.org/almalinux/9/BaseOS/x86_64/os/' },
]

// Windows Server cannot be fetched by a link job: Microsoft hands it out through its Evaluation
// Center, after a form. So the page shows where to download it, and the user then chooses the file.
const WINDOWS_SERVER = [
  { id: 'winserver-2025', name: 'Windows Server 2025 (evaluation)', page: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2025' },
  { id: 'winserver-2022', name: 'Windows Server 2022 (evaluation)', page: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2022' },
  { id: 'winserver-2019', name: 'Windows Server 2019 (evaluation)', page: 'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2019' },
]

// Sent with every answer. The page loads nothing from other sites and cannot be framed.
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    'upgrade-insecure-requests',
  ].join('; '),
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), interest-cohort=()',
}

function secure(response) {
  const out = new Response(response.body, response)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
  return out
}

const json = (data, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
    },
  })

/** Runs `make` once, then serves the saved answer from Cloudflare's cache for `ttl` seconds. */
async function cached(ctx, key, ttl, make) {
  const cache = caches.default
  const req = new Request(`https://cache.mkstick.invalid/${key}`)
  const hit = await cache.match(req)
  if (hit) return hit.json()
  const value = await make()
  ctx.waitUntil(cache.put(req, json(value, 200, ttl)))
  return value
}

/** True when this visitor has made too many requests of this kind in the last minute. */
async function tooMany(env, limiter, request) {
  const binding = env[limiter]
  if (!binding) return false // not configured (local development)
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  try {
    return !(await binding.limit({ key: ip })).success
  } catch {
    return false
  }
}

const versionKey = (name) => (name.match(/\d+/g) || []).map((n) => n.padStart(4, '0')).join('.')

/** Reads a checksum file in either layout: "<hash>  <file>" or "SHA256 (<file>) = <hash>". */
function checksumRows(text) {
  const rows = []
  for (const line of text.slice(0, 200000).split('\n')) {
    const l = line.trim()
    const a = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l)
    const b = /^SHA256 \((\S+)\) = ([0-9a-f]{64})$/.exec(l)
    if (a) rows.push([a[1], a[2]])
    else if (b) rows.push([b[2], b[1]])
  }
  return rows
}

async function linuxEntry(def) {
  const mirror = MIRRORS[def.mirror]
  let dir = def.dir || ''
  if (def.pickDir) {
    // The newest version folder, such as 22.3/
    const list = await fetch(mirror.base)
    if (!list.ok) throw new Error(`${mirror.host} answered ${list.status}`)
    const dirs = [...(await list.text()).slice(0, 200000).matchAll(/href="(\d+(?:\.\d+)*\/)"/g)].map((m) => m[1])
    dir = dirs.sort((a, b) => (versionKey(a) < versionKey(b) ? -1 : 1)).pop() || ''
  }
  let rows
  if (def.perFile) {
    const list = await fetch(mirror.base + dir)
    if (!list.ok) throw new Error(`${mirror.host} answered ${list.status}`)
    const names = [...(await list.text()).slice(0, 400000).matchAll(/href="([^"]+\.iso)"/g)].map((m) => m[1]).filter((n) => def.match.test(n))
    const name = names.sort((a, b) => (versionKey(a) < versionKey(b) ? -1 : 1)).pop()
    if (!name) throw new Error(`No image found on ${mirror.host}`)
    const sum = await fetch(`${mirror.base}${dir}${name}.sha256`)
    const hash = sum.ok ? /^([0-9a-f]{64})/.exec((await sum.text()).trim())?.[1] : null
    if (!hash) throw new Error('No checksum')
    rows = [[hash, name]]
  } else {
    const res = await fetch(mirror.base + dir + (def.sums || 'SHA256SUMS'))
    if (!res.ok) throw new Error(`${mirror.host} answered ${res.status}`)
    rows = checksumRows(await res.text())
      .filter((r) => def.match.test(r[1]))
      .sort((a, b) => (versionKey(a[1]) < versionKey(b[1]) ? -1 : 1))
  }
  const row = rows.pop()
  if (!row) throw new Error(`No image found on ${mirror.host}`)
  const [sha256, file] = row
  const head = await fetch(mirror.base + dir + file, { method: 'HEAD' })
  return {
    id: def.id,
    kind: 'linux',
    name: def.name,
    file,
    sha256,
    size: Number(head.headers.get('content-length')) || null,
    url: `/mirror/${def.mirror}/${dir}${file}`,
    from: mirror.host,
    stick: def.stick,
    ...(def.patch ? { patch: def.patch, repo: def.repo } : {}),
  }
}

async function catalogue(ctx) {
  const linux = await cached(ctx, 'catalogue-linux-v3', 3600, async () => {
    const out = []
    for (const def of LINUX) {
      try {
        out.push(await linuxEntry(def))
      } catch {
        out.push({ id: def.id, kind: 'linux', name: def.name, error: 'unavailable' })
      }
    }
    return out
  })
  const windows = Object.entries(WINDOWS_PRODUCTS).map(([id, p]) => ({
    id,
    kind: 'windows',
    name: p.name,
    archs: p.archs,
    stick: 16,
    page: `https://www.microsoft.com/software-download/${p.page}`,
  }))
  const servers = WINDOWS_SERVER.map((p) => ({ id: p.id, kind: 'windows', manual: true, name: p.name, archs: ['x64'], stick: 16, page: p.page }))
  return [...windows, ...servers, ...linux]
}

/** A download link is only passed on if it is an https address on a Microsoft server. */
function isMicrosoftUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && (u.hostname === 'microsoft.com' || u.hostname.endsWith('.microsoft.com'))
  } catch {
    return false
  }
}

const knownWindows = (product, arch) => Object.hasOwn(WINDOWS_PRODUCTS, product) && WINDOWS_PRODUCTS[product].archs.includes(arch)
const linkKey = (product, arch, lang) => `link:${product}:${arch}:${lang.toLowerCase()}`

async function windowsLink(url, env) {
  const product = url.searchParams.get('product') || ''
  const arch = url.searchParams.get('arch') || 'x64'
  const lang = url.searchParams.get('lang') || 'English'
  if (!knownWindows(product, arch) || !LANG.test(lang)) return json({ error: 'Unknown Windows version, processor or language' }, 400)
  const page = `https://www.microsoft.com/software-download/${WINDOWS_PRODUCTS[product].page}`
  const row = env.LINKS ? await env.LINKS.get(linkKey(product, arch, lang), 'json') : null
  // A stored link is checked again on the way out, so a bad entry can never send anyone elsewhere.
  if (!row || !isMicrosoftUrl(row.url) || Date.now() - row.fetchedAt > LINK_LIFE * 1000) {
    return json({ error: 'No direct link is held for that choice just now', page }, 404)
  }
  return json({ url: row.url, fileName: row.fileName, language: row.language, fetchedAt: row.fetchedAt })
}

async function windowsLanguages(url, env) {
  const product = url.searchParams.get('product') || ''
  const arch = url.searchParams.get('arch') || 'x64'
  if (!knownWindows(product, arch)) return json({ error: 'Unknown Windows version or processor' }, 400)
  const row = env.LINKS ? await env.LINKS.get(`langs:${product}:${arch}`, 'json') : null
  const fresh = row && Date.now() - row.at < LINK_LIFE * 1000
  return json(fresh ? row.list : [])
}

/** Compares two secrets without giving away, through timing, how much of a guess was right. */
async function sameSecret(a, b) {
  const enc = new TextEncoder()
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))])
  return crypto.subtle.timingSafeEqual(x, y)
}

/** The scheduled job hands over fresh links. Nothing else can write to mkstick. */
async function storeLinks(request, env) {
  if (!env.LINKS || !env.LINKS_TOKEN) return json({ error: 'Link storage is not set up' }, 503)
  const given = (request.headers.get('authorization') || '').replace(/^Bearer /, '')
  if (!given || !(await sameSecret(given, env.LINKS_TOKEN))) return json({ error: 'Not allowed' }, 401)
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) return json({ error: 'Send JSON' }, 415)
  const text = await request.text()
  if (text.length > 65536) return json({ error: 'Too large' }, 413)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'Bad JSON' }, 400)
  }
  const rows = Array.isArray(body?.links) ? body.links.slice(0, 120) : []
  const now = Date.now()
  const langs = new Map()
  let stored = 0
  for (const r of rows) {
    const ok =
      r && typeof r === 'object' && knownWindows(r.product, r.arch) &&
      typeof r.lang === 'string' && LANG.test(r.lang) &&
      typeof r.url === 'string' && r.url.length < 2000 && isMicrosoftUrl(r.url) &&
      typeof r.fileName === 'string' && /^[A-Za-z0-9._-]{1,120}\.iso$/.test(r.fileName)
    if (!ok) continue
    const language = typeof r.language === 'string' && /^[\p{L}\p{N} ()-]{1,60}$/u.test(r.language) ? r.language : r.lang
    await env.LINKS.put(linkKey(r.product, r.arch, r.lang), JSON.stringify({ url: r.url, fileName: r.fileName, language, fetchedAt: now }), { expirationTtl: LINK_LIFE })
    const key = `langs:${r.product}:${r.arch}`
    if (!langs.has(key)) langs.set(key, [])
    langs.get(key).push({ language: r.lang, name: language })
    stored++
  }
  for (const [key, list] of langs) await env.LINKS.put(key, JSON.stringify({ at: now, list }), { expirationTtl: LINK_LIFE })
  return json({ stored })
}

async function mirror(request, url) {
  const [, , id, ...rest] = url.pathname.split('/')
  const target = Object.hasOwn(MIRRORS, id) ? MIRRORS[id] : null
  const path = rest.join('/')
  const allowed = /^[A-Za-z0-9._\-/]{1,200}$/.test(path) && !path.includes('..') && !path.includes('//') && path.endsWith('.iso')
  if (!target || !allowed) return new Response('Not found', { status: 404 })

  // Only mkstick's own page may use this, and only for pieces of a file. That stops other
  // sites, and people looking for a free download mirror, from using it.
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return new Response('Forbidden', { status: 403 })
  const range = request.headers.get('range') || ''
  if (!/^bytes=\d{1,15}-\d{0,15}$/.test(range)) return new Response('A Range header is required', { status: 416 })

  // Now and then a publisher's server ignores the Range header and starts sending the whole
  // image. Drop that answer and ask again, so a 6 GB file is never sent by mistake.
  let upstream = null
  for (let attempt = 0; attempt < 4 && !upstream; attempt++) {
    const res = await fetch(target.base + path, { method: request.method, headers: { range }, redirect: 'follow' })
    if (res.status === 200 || !res.url.startsWith('https://')) await res.body?.cancel()
    else upstream = res
  }
  if (!upstream) return new Response('The publisher did not send the part that was asked for', { status: 502 })

  const out = new Headers()
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  out.set('content-type', 'application/octet-stream')
  out.set('cache-control', 'no-store')
  out.set('x-mkstick-source', target.host)
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

// The header and footer are czt.sh's own. They are read from the main site once an hour, so a
// change there shows up here without touching mkstick. If czt.sh cannot be reached, the copy
// built into index.html is used.
const MAIN_SITE = 'https://czt.sh'

// The main site is trusted, but its markup is still cut down before it is used: no scripts,
// frames, forms, inline handlers or styles, and no links other than https and mailto.
function cleanFragment(html) {
  return html
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|form|link|meta|base|template|input)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(style|srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)="\/(?!\/)/g, `$1="${MAIN_SITE}/`)
    .replace(/\s(href|src|xlink:href)\s*=\s*("(?!https:\/\/|mailto:|#)[^"]*"|'[^']*'|[^\s>"']+)/gi, ' $1="#"')
}

async function siteFrame(ctx) {
  try {
    return await cached(ctx, 'frame-v2', 3600, async () => {
      const res = await fetch(`${MAIN_SITE}/`, { headers: { accept: 'text/html' } })
      if (!res.ok) throw new Error('main site unavailable')
      const html = (await res.text()).slice(0, 600000)
      const header = /<header class="site-header"[\s\S]*?<\/header>/.exec(html)?.[0]
      const footer = /<footer class="site-footer[\s\S]*?<\/footer>/.exec(html)?.[0]
      if (!header || !footer || header.length > 40000 || footer.length > 40000) throw new Error('frame not found')
      // The footer is the main site's, plus one quiet link of Project mkstick's own.
      const support = '<p class="container p-foot-base p-foot-support"><a href="#support">Support Project mkstick</a></p>'
      return { header: cleanFragment(header), footer: cleanFragment(footer).replace(/<\/footer>\s*$/, `${support}</footer>`) }
    })
  } catch {
    return null
  }
}

async function page(request, env, ctx) {
  const res = await env.ASSETS.fetch(request)
  if (!(res.headers.get('content-type') || '').includes('text/html') || res.status !== 200) return res
  const frame = await siteFrame(ctx)
  const html = new Response(res.body, res)
  html.headers.set('cache-control', 'no-cache') // always check for a newer page
  if (!frame) return html
  return new HTMLRewriter()
    .on('header.site-header', { element: (el) => void el.replace(frame.header, { html: true }) })
    .on('footer.site-footer', { element: (el) => void el.replace(frame.footer, { html: true }) })
    .transform(html)
}

async function route(request, env, ctx) {
  const url = new URL(request.url)
  const busy = () => json({ error: 'Too many requests. Wait a minute and try again.' }, 429)
  if (request.method === 'POST' && url.pathname === '/api/windows/links') {
    if (await tooMany(env, 'WRITE_LIMIT', request)) return busy()
    return storeLinks(request, env)
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  if (url.pathname.startsWith('/mirror/')) {
    if (await tooMany(env, 'MIRROR_LIMIT', request)) return busy()
    return mirror(request, url)
  }
  if (url.pathname.startsWith('/api/')) {
    if (await tooMany(env, 'API_LIMIT', request)) return busy()
    if (url.pathname === '/api/catalogue') return json(await catalogue(ctx))
    if (url.pathname === '/api/windows/link') return windowsLink(url, env)
    if (url.pathname === '/api/windows/languages') return windowsLanguages(url, env)
    return json({ error: 'Not found' }, 404)
  }
  return page(request, env, ctx)
}

export default {
  async fetch(request, env, ctx) {
    try {
      return secure(await route(request, env, ctx))
    } catch {
      return secure(json({ error: 'Something went wrong' }, 500))
    }
  },
}
