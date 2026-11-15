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
}

const LINUX = [
  {
    id: 'ubuntu-desktop',
    name: 'Ubuntu Desktop 24.04 LTS',
    mirror: 'ubuntu',
    dir: '24.04/',
    match: /^ubuntu-[\d.]+-desktop-amd64\.iso$/,
    stick: 8,
  },
  {
    id: 'ubuntu-server',
    name: 'Ubuntu Server 24.04 LTS',
    mirror: 'ubuntu',
    dir: '24.04/',
    match: /^ubuntu-[\d.]+-live-server-amd64\.iso$/,
    stick: 8,
  },
  {
    id: 'debian',
    name: 'Debian (network installer)',
    mirror: 'debian',
    dir: 'debian-cd/current/amd64/iso-cd/',
    match: /^debian-[\d.]+-amd64-netinst\.iso$/,
    stick: 2,
  },
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

async function linuxEntry(def) {
  const mirror = MIRRORS[def.mirror]
  const res = await fetch(mirror.base + def.dir + 'SHA256SUMS')
  if (!res.ok) throw new Error(`${mirror.host} answered ${res.status}`)
  const rows = (await res.text())
    .slice(0, 100000)
    .split('\n')
    .map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(l.trim()))
    .filter((m) => m && def.match.test(m[2]))
    .sort((a, b) => (versionKey(a[2]) < versionKey(b[2]) ? -1 : 1))
  const row = rows.pop()
  if (!row) throw new Error(`No image found on ${mirror.host}`)
  const head = await fetch(mirror.base + def.dir + row[2], { method: 'HEAD' })
  return {
    id: def.id,
    kind: 'linux',
    name: def.name,
    file: row[2],
    sha256: row[1],
    size: Number(head.headers.get('content-length')) || null,
    url: `/mirror/${def.mirror}/${def.dir}${row[2]}`,
    from: mirror.host,
    stick: def.stick,
  }
}

async function catalogue(ctx) {
  const linux = await cached(ctx, 'catalogue-linux-v2', 3600, async () => {
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
  return [...windows, ...linux]
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
