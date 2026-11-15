// Gets official Windows ISO download links from Microsoft. Run by the scheduled job in this
// folder, not by the Worker, because Microsoft rejects these requests from Cloudflare's network.
// Written from how the public download page works; it does not copy any other tool's code.
// Microsoft only gives a link to a "session" it has seen the page load, so we replay the
// same steps the download page does. Links expire after about 24 hours.

const ORG_ID = 'y6jn8c31'
const PROFILE_ID = '606624d44113'
const INSTANCE_ID = '560dc9f3-1aa5-4a2f-b63c-9e18f8d0e175'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

// Edition ids on Microsoft's download page. Windows 11 has one id per CPU type.
export const WINDOWS_PRODUCTS = {
  win11: { name: 'Windows 11', page: 'windows11', editions: { x64: 3813, arm64: 3816 } },
  win10: { name: 'Windows 10', page: 'Windows10ISO', editions: { x64: 2618 } },
}

// DownloadType values in Microsoft's reply.
const ARCH_BY_TYPE = { 0: 'x86', 1: 'x64', 2: 'arm64', 9: 'x64', 10: 'arm64' }

async function getText(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { 'User-Agent': UA, ...(init.headers || {}) },
  })
  return { res, text: await res.text() }
}

async function getJson(url, init) {
  const { res, text } = await getText(url, init)
  if (!res.ok) throw new Error(`Microsoft answered ${res.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Microsoft sent a reply we could not read')
  }
}

/** Opens a session Microsoft will accept. Returns the session id. */
export async function openSession() {
  const sessionId = crypto.randomUUID()
  await getText(`https://vlscppe.microsoft.com/tags?org_id=${ORG_ID}&session_id=${sessionId}`)
  const { text: script } = await getText(
    `https://ov-df.microsoft.com/mdt.js?instanceId=${INSTANCE_ID}&PageId=si&session_id=${sessionId}`,
  )
  const w = /[?&]w=([A-F0-9]+)/.exec(script)?.[1]
  const rticks = /rticks="\+?(\d+)/.exec(script)?.[1]
  if (!w || !rticks) throw new Error('Microsoft changed its download page (session step)')
  await getText(
    `https://ov-df.microsoft.com/?session_id=${sessionId}&CustomerId=${INSTANCE_ID}&PageId=si&w=${w}&mdt=${Date.now()}&rticks=${rticks}`,
  )
  return sessionId
}

/**
 * @param {string} product  key of WINDOWS_PRODUCTS
 * @param {string} arch     'x64' or 'arm64'
 * @param {string} language Microsoft's language name, e.g. 'English' or 'English International'
 * @returns {Promise<{url:string,fileName:string,arch:string,language:string}>}
 */
export async function getWindowsLink(product, arch, language, givenSession) {
  const locale = 'en-US'
  const def = WINDOWS_PRODUCTS[product]
  const editionId = def?.editions[arch]
  if (!editionId) throw new Error('Unknown Windows version or CPU type')

  // A session the visitor's own browser opened with Microsoft is accepted far more often
  // than one opened from a data centre.
  const sessionId = givenSession || (await openSession())

  let skus = []
  for (let attempt = 0; attempt < 3 && skus.length === 0; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500))
    const info = await getJson(
      `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${PROFILE_ID}&productEditionId=${editionId}&SKU=undefined&friendlyFileName=undefined&Locale=${locale}&sessionID=${sessionId}`,
    )
    if (info.Errors?.length) throw new Error(info.Errors[0].Value || 'Microsoft refused the request')
    skus = info.Skus || []
  }
  if (!skus.length) throw new Error('Microsoft returned no languages')

  const sku = skus.find((s) => s.Language === language) || skus.find((s) => s.Language === 'English') || skus[0]

  const links = await getJson(
    `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku?profile=${PROFILE_ID}&productEditionId=undefined&SKU=${sku.Id}&friendlyFileName=undefined&Locale=${locale}&sessionID=${sessionId}`,
    { headers: { Referer: `https://www.microsoft.com/software-download/${def.page}` } },
  )
  if (links.Errors?.length) {
    // Type 9 means Microsoft has blocked this address for a while.
    if (links.Errors[0].Type === 9) throw new Error('Microsoft has blocked this server for now (code 715-123130)')
    throw new Error(links.Errors[0].Value || 'Microsoft refused the request')
  }
  const options = links.ProductDownloadOptions || []
  const hit = options.find((o) => ARCH_BY_TYPE[o.DownloadType] === arch) || options[0]
  if (!hit?.Uri) throw new Error('Microsoft returned no download link')
  const fileName = decodeURIComponent(new URL(hit.Uri).pathname.split('/').pop() || 'windows.iso')
  return {
    url: hit.Uri,
    fileName,
    arch: ARCH_BY_TYPE[hit.DownloadType] || arch,
    language: sku.LocalizedLanguage || sku.Language,
  }
}

export async function listWindowsLanguages(product, arch) {
  const def = WINDOWS_PRODUCTS[product]
  const editionId = def?.editions[arch]
  if (!editionId) throw new Error('Unknown Windows version or CPU type')
  const sessionId = await openSession()
  const info = await getJson(
    `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${PROFILE_ID}&productEditionId=${editionId}&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=${sessionId}`,
  )
  if (info.Errors?.length) throw new Error(info.Errors[0].Value || 'Microsoft refused the request')
  return (info.Skus || []).map((s) => ({ id: s.Id, language: s.Language, name: s.LocalizedLanguage }))
}

/**
 * Gets links for several languages of one product, sharing one session so Microsoft sees
 * as few requests as possible.
 * @returns {Promise<Array<{product,arch,lang,language,url,fileName}>>}
 */
export async function fetchLinks(product, arch, languages, log = () => {}) {
  const def = WINDOWS_PRODUCTS[product]
  const editionId = def?.editions[arch]
  if (!editionId) throw new Error('Unknown Windows version or CPU type')
  const plain = (v) => String(v || '').toLowerCase().replace(/[^a-z]/g, '')
  const out = []
  // A new session is opened for every five languages, to keep each session short.
  for (let i = 0; i < languages.length; i += 5) {
    const sessionId = await openSession()
    const info = await getJson(
      `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition?profile=${PROFILE_ID}&productEditionId=${editionId}&SKU=undefined&friendlyFileName=undefined&Locale=en-US&sessionID=${sessionId}`,
    )
    if (info.Errors?.length) throw new Error(info.Errors[0].Value || 'Microsoft refused the request')
    for (const lang of languages.slice(i, i + 5)) {
      const sku = (info.Skus || []).find((s) => plain(s.Language) === plain(lang) || plain(s.LocalizedLanguage) === plain(lang))
      if (!sku) {
        log(`${product} ${arch} ${lang}: not offered`)
        continue
      }
      await new Promise((r) => setTimeout(r, 1200))
      try {
        const links = await getJson(
          `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku?profile=${PROFILE_ID}&productEditionId=undefined&SKU=${sku.Id}&friendlyFileName=undefined&Locale=en-US&sessionID=${sessionId}`,
          { headers: { Referer: `https://www.microsoft.com/software-download/${def.page}` } },
        )
        if (links.Errors?.length) throw new Error(links.Errors[0].Value || 'refused')
        const options = links.ProductDownloadOptions || []
        const hit = options.find((o) => ARCH_BY_TYPE[o.DownloadType] === arch) || options[0]
        if (!hit?.Uri) throw new Error('no link in the reply')
        const fileName = decodeURIComponent(new URL(hit.Uri).pathname.split('/').pop() || 'windows.iso')
        out.push({ product, arch, lang, language: sku.LocalizedLanguage || lang, url: hit.Uri, fileName })
        log(`${product} ${arch} ${lang}: ok (${fileName})`)
      } catch (e) {
        log(`${product} ${arch} ${lang}: failed (${e.message})`)
      }
    }
  }
  return out
}
