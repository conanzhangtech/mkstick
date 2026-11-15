// Checks a running mkstick site against the protections listed in SECURITY.md.
// node test/security-check.mjs https://mkstick.czt.sh
const base = (process.argv[2] || 'http://localhost:8794').replace(/\/$/, '')
const iso = '/mirror/debian/debian-cd/current/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso'
let failed = 0

function check(name, ok, detail = '') {
  if (!ok) failed++
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`)
}
const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init })
const status = async (path, init) => {
  const res = await get(path, init)
  await res.body?.cancel()
  return res.status
}

// --- headers on the page
const home = await get('/')
const h = home.headers
const csp = h.get('content-security-policy') || ''
const html = await home.text()
check('page loads', home.status === 200)
check("CSP starts from default-src 'none'", csp.includes("default-src 'none'"))
check('CSP allows scripts from this site only', /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp), csp)
check("CSP has no 'unsafe-inline' or 'unsafe-eval'", !/'unsafe-inline'|'unsafe-eval'/.test(csp))
check('CSP forbids framing', csp.includes("frame-ancestors 'none'"))
check('CSP forbids forms and base tags', csp.includes("form-action 'none'") && csp.includes("base-uri 'none'"))
check('CSP requires Trusted Types', csp.includes("require-trusted-types-for 'script'"))
check('HSTS is set for a year', /max-age=31536000/.test(h.get('strict-transport-security') || ''))
check('nosniff is set', h.get('x-content-type-options') === 'nosniff')
check('framing is denied', h.get('x-frame-options') === 'DENY')
check('no referrer is sent', h.get('referrer-policy') === 'no-referrer')
check('cross-origin opener and resource policies', h.get('cross-origin-opener-policy') === 'same-origin' && h.get('cross-origin-resource-policy') === 'same-origin')
check('device features are switched off', /camera=\(\).*usb=\(\)/.test(h.get('permissions-policy') || ''))
check('no cookies are set', !h.get('set-cookie'))
check('no CORS header is sent', !h.get('access-control-allow-origin'))

// --- the page itself
// Search-engine data blocks (application/ld+json) are data, not code, and are allowed.
check('no inline scripts', !/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>/i.test(html))
check('no inline event handlers', !/\son[a-z]+\s*=/i.test(html))
check('no inline styles', !/\sstyle\s*=/i.test(html) && !/<style/i.test(html))
// A canonical link names an address and loads nothing, so it does not count.
const outside = [...html.matchAll(/<(?:script|link|img|iframe)(?![^>]*rel="canonical")[^>]+(?:src|href)="(https?:\/\/[^"]+)"/gi)].map((m) => m[1])
check('nothing is loaded from other sites', outside.length === 0, outside.join(', '))
check('every new-tab link has rel=noopener', [...html.matchAll(/<a [^>]*target="_blank"[^>]*>/g)].every((m) => /rel="[^"]*noopener/.test(m[0])))

// --- methods
check('POST is refused on the page', (await status('/', { method: 'POST' })) === 405)
check('PUT is refused on the API', (await status('/api/catalogue', { method: 'PUT' })) === 405)
check('DELETE is refused on the API', (await status('/api/catalogue', { method: 'DELETE' })) === 405)

// --- the pass-through
const browser = { 'sec-fetch-site': 'same-origin' }
check('pass-through serves a piece to the page', (await status(iso, { headers: { ...browser, range: 'bytes=0-9' } })) === 206)
check('pass-through refuses a whole file', (await status(iso, { headers: browser })) === 416)
check('pass-through refuses other sites', (await status(iso, { headers: { 'sec-fetch-site': 'cross-site', range: 'bytes=0-9' } })) === 403)
check('pass-through refuses non-browser clients', (await status(iso, { headers: { range: 'bytes=0-9' } })) === 403)
check('pass-through refuses unknown servers', (await status('/mirror/evil/x.iso', { headers: { ...browser, range: 'bytes=0-9' } })) === 404)
check('pass-through refuses files that are not images', (await status('/mirror/ubuntu/24.04/SHA256SUMS', { headers: { ...browser, range: 'bytes=0-9' } })) === 404)
check('pass-through refuses path tricks', (await status('/mirror/ubuntu/24.04/%2e%2e/%2e%2e/x.iso', { headers: { ...browser, range: 'bytes=0-9' } })) === 404)
check('pass-through refuses full addresses', (await status('/mirror/ubuntu/https://example.com/x.iso', { headers: { ...browser, range: 'bytes=0-9' } })) === 404)

// --- the API
check('unknown Windows version is refused', (await status('/api/windows/link?product=__proto__&arch=x64')) === 400)
check('odd language text is refused', (await status('/api/windows/link?product=win11&arch=x64&lang=%3Cscript%3E')) === 400)
check('unknown API path is not found', (await status('/api/nothing')) === 404)
const link = await get('/api/windows/link?product=win11&arch=x64&lang=English')
if (link.status === 200) {
  const url = new URL((await link.json()).url)
  check('a stored Windows link points at Microsoft over https', url.protocol === 'https:' && url.hostname.endsWith('.microsoft.com'), url.hostname)
} else {
  await link.body?.cancel()
  check('no Windows link is held, which is allowed', link.status === 404)
}

// --- the write endpoint
const post = (headers, body) => status('/api/windows/links', { method: 'POST', headers, body })
const evil = JSON.stringify({ links: [{ product: 'win11', arch: 'x64', lang: 'English', url: 'https://evil.example/x.iso', fileName: 'x.iso' }] })
const json = { 'content-type': 'application/json' }
check('writing without the secret is refused', [401, 503].includes(await post(json, evil)))
check('writing with a wrong secret is refused', [401, 503].includes(await post({ ...json, authorization: 'Bearer wrong' }, evil)))
check('reading the write endpoint is not found', (await status('/api/windows/links')) === 404)

// --- things that must not be served
for (const path of ['/.git/config', '/wrangler.jsonc', '/.env', '/src/index.js', '/jobs/fetch-links.mjs', '/test/flash-cli.mjs']) {
  const res = await get(path)
  const text = await res.text()
  check(`${path} is not served`, res.status === 404 || text.includes('<title>mkstick'))
}
check('security.txt is published', (await status('/.well-known/security.txt')) === 200)

console.log(failed ? `\n${failed} checks failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)
