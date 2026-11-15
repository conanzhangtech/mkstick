// Scheduled job: asks Microsoft for fresh Windows download links and hands them to mkstick.
// Microsoft's links last about 24 hours, so this runs every few hours.
//
//   MKSTICK_URL    the site, e.g. https://staging.mkstick.czt.sh
//   MKSTICK_TOKEN  the shared secret the site checks (LINKS_TOKEN on the Worker)
//   PRODUCT, ARCH  optional: fetch one version only, e.g. win11 and arm64
import { fetchLinks } from './mslink.js'

// Microsoft answers about eight link requests for one Windows version from one address, then
// refuses the rest. So each run asks for eight languages of one version, and the workflow
// starts a separate runner (with its own address) for each version.
const LANGUAGES = ['English', 'English International', 'Chinese Simplified', 'Chinese Traditional', 'French', 'German', 'Japanese', 'Spanish']
const ALL = [
  ['win11', 'x64'],
  ['win11', 'arm64'],
  ['win10', 'x64'],
]
const PRODUCTS = process.env.PRODUCT ? [[process.env.PRODUCT, process.env.ARCH || 'x64']] : ALL

const site = process.env.MKSTICK_URL
const token = process.env.MKSTICK_TOKEN
if (!site || !token) {
  console.error('MKSTICK_URL and MKSTICK_TOKEN must be set')
  process.exit(2)
}

const links = []
for (const [product, arch] of PRODUCTS) {
  try {
    links.push(...(await fetchLinks(product, arch, LANGUAGES, console.log)))
  } catch (e) {
    console.log(`${product} ${arch}: failed (${e.message})`)
  }
}
console.log(`${links.length} links found`)
if (!links.length) process.exit(1)

const res = await fetch(new URL('/api/windows/links', site), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ links }),
})
console.log(`site answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
process.exit(res.ok ? 0 : 1)
