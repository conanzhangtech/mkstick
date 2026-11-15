import { BlobSource, HttpSource } from './lib/source.js'
import { buildPlan, writePlan, verifySizes } from './lib/flash.js'

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)
const TEST = params.get('target') === 'opfs' // start with the test folder chosen
const canWrite = 'showDirectoryPicker' in window

const STEPS = ['step-what', 'step-files', 'step-stick', 'step-write']
const state = {
  items: [],
  item: null,
  source: null,
  plan: null,
  stick: null,
  stickName: '',
  testStick: false,
  resuming: false,
  busy: false,
  finished: false,
  abort: null,
  focus: null, // a finished step the user reopened with "Change"
}

// Files an operating system leaves on an empty stick. They do not count as "not empty".
const HIDDEN = /^(\..*|System Volume Information|\$RECYCLE\.BIN)$/i

const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)
const el = (tag, props) => Object.assign(document.createElement(tag), props)
const setStatus = (node, text, cls = '') => {
  node.textContent = text
  node.className = `status ${cls}`.trim()
}

// ---------- Step 1: pick a system ----------

async function loadCatalogue() {
  const box = $('catalogue')
  let failed = ''
  try {
    const res = await fetch('/api/catalogue')
    if (res.status === 429) throw new Error('Project mkstick is busy at the moment, so please try again in a minute.')
    if (!res.ok) throw new Error('The list of systems could not be loaded, so please reload the page.')
    state.items = await res.json()
  } catch (e) {
    state.items = []
    failed = /please/.test(e.message) ? e.message : 'The list of systems could not be loaded, so please check your connection and reload the page.'
  }
  state.items.push({ id: 'custom', kind: 'custom', name: 'An ISO file I already have' })
  box.replaceChildren()
  if (failed) box.append(el('p', { className: 'status bad', textContent: failed }))
  const groups = [
    ['Windows', (i) => i.kind === 'windows'],
    ['Linux', (i) => i.kind === 'linux'],
    ['Something else', (i) => i.kind === 'custom'],
  ]
  for (const [title, test] of groups) {
    const list = state.items.filter(test)
    if (!list.length) continue
    box.append(el('h3', { textContent: title }))
    for (const item of list) {
      const row = el('label', { className: 'row' + (item.error ? ' off' : '') })
      const input = el('input', { type: 'radio', name: 'what', value: item.id, disabled: !!item.error })
      const name = el('span', { className: 'name', textContent: item.name })
      const meta = el('span', { className: 'meta' })
      if (item.error) meta.textContent = 'not available right now'
      else if (item.kind === 'linux') meta.textContent = `${item.size ? gb(item.size) + ', ' : ''}fits a ${item.stick} GB stick`
      else if (item.kind === 'windows') meta.textContent = `needs a ${item.stick} GB stick`
      else meta.textContent = 'any Windows or Linux installer'
      input.addEventListener('change', () => choose(item))
      row.append(input, name, meta)
      box.append(row)
    }
  }
}

async function choose(item) {
  await state.source?.close?.()
  Object.assign(state, { item, source: null, plan: null, focus: null, finished: false })
  $('done').hidden = true
  $('files-windows').hidden = item.kind !== 'windows'
  $('files-linux').hidden = item.kind !== 'linux'
  $('files-pick').hidden = item.kind === 'linux'
  $('file').value = ''
  $('drop-text').textContent = 'Choose the ISO file, or drag it here'
  setStatus($('image-status'), '')
  if (item.kind === 'windows') {
    const arch = $('win-arch')
    arch.replaceChildren(...item.archs.map((a) => new Option(a === 'x64' ? '64-bit Intel or AMD (most PCs)' : '64-bit Arm (Snapdragon PCs)', a)))
    $('win-bits').textContent =
      item.id === 'win10'
        ? 'This is the 64-bit version, which suits any PC made since about 2010. Windows 10 also exists in 32-bit for very old PCs, and that one is only on Microsoft\'s download page.'
        : 'Windows 11 only comes in 64-bit, so there is no 32-bit choice to make. Nearly every PC has an Intel or AMD processor. Choose Arm only for a PC with a Snapdragon chip, which includes many Copilot+ laptops. If you are not sure, open Settings, then System, then About on that PC and read the line called "System type".'
    $('win-download').textContent = `Download ${item.name} from Microsoft`
    $('win-page-alt').href = item.page
    setStatus($('win-status'), '')
    showWindowsDirect(false)
    loadLanguages()
    $('win-page').href = item.page
    $('win-how').textContent =
      item.id === 'win10'
        ? "On that page, pick the edition and your language, then press the 64-bit Download button. If you're on a Windows PC, the page offers a tool instead, and that tool can save an ISO file when you choose \"ISO file\"."
        : `On that page, scroll to "Download ${item.name} Disk Image (ISO)", pick the edition and your language, then press the 64-bit Download button. The file is about 6 GB.`
  }
  if (item.kind === 'linux') {
    $('linux-text').textContent = `Project mkstick will download ${item.name} from ${item.from} while it writes and check it against the publisher's checksum, so there's nothing for you to do in this step.`
    openRemote(item)
  }
  refresh()
}

// ---------- Step 2: get the installer ----------

// The one-click download is offered when Project mkstick holds a fresh link from Microsoft for this
// version. Otherwise the step shows how to get the file from Microsoft's own page.
function showWindowsDirect(direct) {
  $('win-direct').hidden = !direct
  $('win-manual').hidden = direct
}

async function loadLanguages() {
  const item = state.item
  try {
    const res = await fetch(`/api/windows/languages?product=${item.id}&arch=${$('win-arch').value}`)
    const list = await res.json()
    if (state.item !== item) return
    if (!res.ok || !Array.isArray(list) || !list.length) return showWindowsDirect(false)
    const select = $('win-lang')
    select.replaceChildren(...list.map((l) => new Option(l.name, l.language)))
    const has = (v) => list.some((l) => l.language === v)
    const local = /^en-(GB|AU|NZ|IE|SG|IN|ZA)/.test(navigator.language) && has('English International')
    select.value = local ? 'English International' : has('English') ? 'English' : list[0].language
    showWindowsDirect(true)
  } catch {
    if (state.item === item) showWindowsDirect(false)
  }
}

function isMicrosoft(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && (u.hostname === 'microsoft.com' || u.hostname.endsWith('.microsoft.com'))
  } catch {
    return false
  }
}

async function downloadWindows() {
  const item = state.item
  const status = $('win-status')
  setStatus(status, 'Getting the link…')
  try {
    const q = new URLSearchParams({ product: item.id, arch: $('win-arch').value, lang: $('win-lang').value })
    const res = await fetch(`/api/windows/link?${q}`)
    const data = await res.json()
    // The link is only followed if it is an https address on a Microsoft server.
    if (!res.ok || !isMicrosoft(data.url)) throw new Error('no link')
    setStatus(status, `Your browser is now downloading ${data.fileName} from Microsoft, which is around 6 GB. When it finishes, choose that file below.`, 'ok')
    const a = el('a', { href: data.url, rel: 'noopener noreferrer' })
    document.body.append(a)
    a.click()
    a.remove()
  } catch {
    if (state.item !== item) return
    showWindowsDirect(false)
  }
}

async function useFile(file) {
  if (!file) return
  $('drop-text').textContent = file.name
  await readImage(new BlobSource(file, file.name), { file: file.name })
}

async function openRemote(item) {
  const status = $('image-status')
  setStatus(status, `Finding ${item.name} on ${item.from}…`)
  try {
    const source = await HttpSource.open(item.url, item.file)
    if (state.item !== item) return
    await readImage(source, { file: item.file, sha256: item.sha256 })
  } catch {
    if (state.item === item) setStatus(status, `Project mkstick couldn't reach ${item.from} just now, so please pick the system again in a moment.`, 'bad')
  }
}

async function readImage(source, info) {
  const item = state.item
  const status = $('image-status')
  setStatus(status, 'Reading the installer…')
  state.source = null
  state.plan = null
  refresh()
  try {
    const plan = await buildPlan(source)
    if (state.item !== item) return
    if (item.kind === 'windows' && plan.kind !== 'windows') throw new Error("That file isn't a Windows installer, so please choose the ISO you downloaded from Microsoft")
    state.source = source
    state.plan = { ...plan, info }
    state.focus = null
    setStatus(status, '')
  } catch (e) {
    if (state.item === item) {
      const again = item.kind === 'linux' ? '' : ' Please choose the file again, and if it still fails, download it once more, because the first download may not have finished.'
      setStatus(status, `${String(e.message).replace(/\.$/, '')}.${again}`, 'bad')
    }
  }
  refresh()
}

// ---------- Step 3: choose the stick ----------

function initTabs() {
  const ua = navigator.userAgent
  const os = /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : 'linux'
  const show = (name) => {
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.os === name))
    for (const p of document.querySelectorAll('.tabpanel')) p.hidden = p.dataset.os !== name
  }
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => show(b.dataset.os))
  show(os)
}

function showFormatHelp() {
  const help = document.querySelector('details.help')
  help.open = true
  return help
}

async function pickStick(useTest) {
  const status = $('stick-status')
  if (!useTest && !canWrite) {
    setStatus(status, "This browser can't write to a USB stick, so please open Project mkstick in Chrome or Edge on a computer.", 'bad')
    return
  }
  try {
    let dir
    if (useTest) {
      const root = await navigator.storage.getDirectory()
      try {
        await root.removeEntry('mkstick-test', { recursive: true })
      } catch {}
      dir = await root.getDirectoryHandle('mkstick-test', { create: true })
    } else {
      dir = await window.showDirectoryPicker({ id: 'mkstick-stick', mode: 'readwrite' })
    }
    const found = []
    for await (const name of dir.keys()) if (!HIDDEN.test(name)) found.push(name)
    const resumable = found.length > 0 && found.every((n) => state.plan.outputs.some((o) => o.path.split('/')[0].toLowerCase() === n.toLowerCase()))
    if (found.length && !resumable) {
      state.stick = null
      const some = found.slice(0, 3).join(', ') + (found.length > 3 ? ' and more' : '')
      setStatus(status, `"${dir.name}" already has files on it (${some}), so Project mkstick won't write there. If that is the right stick, reformat it by following the steps below, which also empties it, and then choose it again.`, 'bad')
      showFormatHelp()
    } else {
      state.stick = dir
      state.testStick = !!useTest
      state.stickName = useTest ? 'a test folder in this browser' : `"${dir.name}"`
      state.resuming = resumable
      state.focus = null
      setStatus(status, '')
    }
  } catch (e) {
    if (e.name === 'AbortError') return
    state.stick = null
    const refused = e.name === 'SecurityError' || e.name === 'NotAllowedError'
    setStatus(
      status,
      refused
        ? "The browser didn't allow that folder. Please choose the stick itself, not a folder on your computer, and allow Project mkstick to edit files on it. If it keeps refusing, eject the stick, unplug it, plug it back in and reformat it by following the steps below."
        : "Project mkstick couldn't open that stick. Please eject it, unplug it and plug it back in, then choose it again. If it still fails, reformat it by following the steps below.",
      'bad',
    )
    showFormatHelp()
  }
  refresh()
}

// ---------- Step 4: write ----------

async function start() {
  if (state.busy || !state.plan || !state.stick) return
  // Two tabs must not write to the same stick at once.
  let unlock = null
  if (navigator.locks) {
    const name = `mkstick-write:${state.testStick ? 'test folder' : state.stick.name}`
    const free = await new Promise((resolve) => {
      navigator.locks.request(name, { ifAvailable: true }, (held) => {
        if (!held) return resolve(false)
        resolve(true)
        return new Promise((done) => (unlock = done))
      })
    })
    if (!free) {
      $('error').hidden = false
      $('reformat').hidden = true
      $('error-text').textContent = 'Another Project mkstick tab is already writing to this stick, so please wait for that one to finish. To make a second stick at the same time, use a different stick in this tab.'
      return
    }
  }
  state.busy = true
  state.finished = false
  state.abort = new AbortController()
  $('error').hidden = true
  $('done').hidden = true
  $('progress').hidden = false
  $('stop').hidden = false
  refresh()

  const { plan, source } = state
  const hasher = window.hashwasm ? await window.hashwasm.createSHA256() : null
  hasher?.init()
  let lock = null
  try {
    lock = await navigator.wakeLock?.request('screen')
  } catch {}
  const leave = (e) => {
    e.preventDefault()
    e.returnValue = ''
  }
  addEventListener('beforeunload', leave)

  const started = performance.now()
  const samples = []
  let lastPaint = 0
  const onProgress = ({ done, total, path }) => {
    const now = performance.now()
    if (now - lastPaint < 200 && done < total) return
    lastPaint = now
    samples.push([now, done])
    while (samples.length > 2 && now - samples[0][0] > 8000) samples.shift()
    const [t0, d0] = samples[0]
    const speed = now > t0 ? ((done - d0) / (now - t0)) * 1000 : 0
    const left = speed > 0 ? (total - done) / speed : 0
    $('bar').value = total ? done / total : 0
    const eta = left > 90 ? `about ${Math.round(left / 60)} minutes left` : left > 0 ? 'less than two minutes left' : ''
    $('progress-text').textContent = [`${Math.floor((done / total) * 100)}%`, `${gb(done)} of ${gb(total)}`, eta].filter(Boolean).join(' · ')
    $('progress-file').textContent = path
  }

  try {
    const result = await writePlan(source, plan, state.stick, { onProgress, signal: state.abort.signal, hasher })
    $('progress-text').textContent = 'Checking what was written…'
    const wrong = await verifySizes(plan, state.stick)
    if (wrong.length) throw new Error(`${wrong.length} files didn't copy properly, starting with ${wrong[0]}`)
    const digest = result.hashed && hasher ? hasher.digest('hex') : null
    if (digest && plan.info.sha256 && digest !== plan.info.sha256) {
      throw new Error("The download doesn't match the publisher's checksum, which means it was damaged on the way. Please format the stick and start again")
    }
    finish(digest, (performance.now() - started) / 1000)
  } catch (e) {
    const stopped = e.name === 'AbortError'
    const aboutStick = !stopped && !['TypeError', 'NotReadableError'].includes(e.name)
    $('error').hidden = false
    $('reformat').hidden = !aboutStick
    $('error-text').textContent = stopped
      ? "Stopped, so the stick isn't finished yet. Press Try again to carry on from where it stopped."
      : `${friendly(e)}.${aboutStick ? ' If trying again gives the same error, eject the stick, unplug it, plug it back in and reformat it, then start again.' : ''}`
  } finally {
    unlock?.()
    removeEventListener('beforeunload', leave)
    try {
      await lock?.release()
    } catch {}
    state.busy = false
    state.abort = null
    $('stop').hidden = true
    $('progress').hidden = true
    refresh()
  }
}

function friendly(e) {
  if (e.name === 'QuotaExceededError') return "The stick is full, so you'll need a bigger one for this installer"
  if (e.name === 'NotFoundError') return "Project mkstick can no longer find the stick or the ISO file, which usually means the stick was unplugged or the file was moved, so please check both and try again"
  if (e.name === 'NoModificationAllowedError' || e.name === 'NotAllowedError') return 'The browser has stopped allowing Project mkstick to write to the stick, so please choose the stick again'
  if (e.name === 'NotReadableError') return "The ISO file couldn't be read, so please choose it again"
  if (e.name === 'TypeError') return 'The connection dropped, so please check the internet and try again'
  return String(e.message || e).replace(/\.$/, '')
}

function finish(digest, seconds) {
  const plan = state.plan
  state.finished = true
  const rows = [
    ['Written to', state.stickName.replace(/^"|"$/g, '')],
    ['What was written', `${plan.outputs.length.toLocaleString('en-GB')} files, ${gb(plan.totalBytes)}`],
    ['Time taken', seconds > 90 ? `${Math.round(seconds / 60)} minutes` : `${Math.max(1, Math.round(seconds))} seconds`],
  ]
  if (digest && plan.info.sha256) rows.push(['Checksum', "matches the publisher's"])
  else if (digest) rows.push(['SHA-256 of the ISO', el('code', { textContent: digest })])
  showDone(rows)
}

function showDone(rows) {
  const ul = $('done-facts')
  ul.replaceChildren()
  for (const [k, v] of rows) {
    const li = el('li')
    const val = el('span')
    val.append(v)
    li.append(el('span', { className: 'k', textContent: k }), val)
    ul.append(li)
  }
  $('thanks').hidden = !thanksDue()
  $('done').hidden = false
  $('done').scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---------- support ----------

// The thank-you panel appears only after a finished write. "Not now" hides it for 30 days.
// The date is kept in this browser only. If storage is blocked, the panel simply shows again.
const THANKS_KEY = 'mkstick-thanks-dismissed'
const THANKS_REST = 30 * 24 * 3600 * 1000

function thanksDue() {
  try {
    const at = Number(localStorage.getItem(THANKS_KEY))
    return !(at > 0 && Date.now() - at < THANKS_REST)
  } catch {
    return true
  }
}

function dismissThanks() {
  $('thanks').hidden = true
  try {
    localStorage.setItem(THANKS_KEY, String(Date.now()))
  } catch {
    // Storage is blocked. The panel is still closed for this visit.
  }
}

// Supporters are listed in public/supporters.json, edited by hand:
//   [{ "name": "Ada", "link": "https://example.com", "tier": "Sponsor" }]
async function loadSupporters() {
  try {
    const res = await fetch('/supporters.json')
    const list = res.ok ? await res.json() : []
    const people = (Array.isArray(list) ? list : []).filter((p) => p && typeof p.name === 'string' && p.name.trim()).slice(0, 500)
    if (!people.length) return
    const ul = el('ul', { className: 'supporters' })
    for (const p of people) {
      const li = el('li')
      const name = p.name.trim().slice(0, 80)
      let link = null
      try {
        const u = new URL(p.link)
        if (u.protocol === 'https:') link = u.href
      } catch {}
      li.append(link ? el('a', { href: link, target: '_blank', rel: 'noopener noreferrer nofollow', textContent: name }) : name)
      if (typeof p.tier === 'string' && p.tier.trim()) li.append(' ', el('span', { className: 'muted small', textContent: p.tier.trim().slice(0, 40) }))
      ul.append(li)
    }
    $('supporters').replaceChildren(ul)
  } catch {
    // Keep the "Be the first supporter" line.
  }
}

// ---------- shared ----------

function refresh() {
  const haveImage = !!state.plan
  const done = { 'step-what': !!state.item, 'step-files': haveImage, 'step-stick': !!state.stick, 'step-write': state.finished }
  let current = STEPS.find((id) => !done[id]) || null
  const limit = current ? STEPS.indexOf(current) : STEPS.length
  if (state.focus && !state.busy && STEPS.indexOf(state.focus) < limit) current = state.focus
  for (const id of STEPS) {
    const before = current === null || STEPS.indexOf(id) < STEPS.indexOf(current)
    $(id).dataset.state = id === current ? 'current' : before && done[id] ? 'done' : 'todo'
  }

  const item = state.item
  $('sum-what').textContent = item ? item.name : ''
  const bits = haveImage && state.plan.windows?.arch ? `, ${state.plan.windows.arch}` : ''
  $('sum-files').textContent = !haveImage ? '' : item.kind === 'linux' ? `${state.plan.info.file}, downloaded as it writes` : `${state.plan.info.file} (${gb(state.plan.totalBytes)}${bits})`
  $('sum-stick').textContent = state.stick ? state.stickName : ''
  $('sum-write').textContent = state.finished ? 'Finished' : ''

  if (haveImage && state.stick) {
    const what = item.kind === 'custom' ? state.plan.label || state.plan.info.file : item.name
    const w = state.plan.windows
    const names = (w?.editions || []).map((n) => n.replace(/^Windows \d+ /, ''))
    const has = ['Home', 'Pro'].filter((n) => names.includes(n))
    const editions = names.length > 1 ? ` It holds ${names.length} editions${has.length ? `, including ${has.join(' and ')}` : ''}, and Windows Setup asks which one to install.` : ''
    const built = w?.arch ? ` This copy of Windows is ${w.arch}.${editions}` : ''
    const split = state.plan.notes.some((n) => n.includes('split')) ? ' The large Windows file is split into parts along the way, which is normal.' : ''
    const resume = state.resuming ? ' Part of it is already there, so Project mkstick will carry on from where it stopped.' : ''
    $('write-plan').textContent = `Project mkstick will write ${what} to ${state.stickName}, which takes up ${gb(state.plan.totalBytes)}.${built}${split}${resume}`
  }
  document.querySelector('.change[data-step="step-files"]').hidden = item?.kind === 'linux'
  $('start').disabled = state.busy || !haveImage || !state.stick
  $('start').textContent = state.busy ? 'Writing…' : state.testStick ? 'Write to the test folder' : 'Write to the stick'
  for (const node of document.querySelectorAll('#catalogue input, #file, #win-download, #win-lang, #win-arch, #pick-stick, #pick-test, .change')) {
    node.disabled = state.busy || (node.name === 'what' && !!node.closest('.off'))
  }
}

function init() {
  $('unsupported').hidden = canWrite
  initTabs()
  loadCatalogue()
  $('win-download').addEventListener('click', downloadWindows)
  $('win-arch').addEventListener('change', loadLanguages)
  $('file').addEventListener('change', (e) => useFile(e.target.files[0]))
  const drop = $('drop')
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over')))
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over')))
  drop.addEventListener('drop', (e) => useFile(e.dataTransfer.files[0]))
  $('pick-stick').addEventListener('click', () => pickStick(TEST))
  $('pick-test').addEventListener('click', () => pickStick(true))
  $('start').addEventListener('click', start)
  $('retry').addEventListener('click', start)
  $('stop').addEventListener('click', () => state.abort?.abort())
  $('thanks-close').addEventListener('click', dismissThanks)
  loadSupporters()
  $('reformat').addEventListener('click', () => {
    // Back to the stick step with the reformat steps open; the stick has to be chosen again afterwards.
    state.stick = null
    state.focus = null
    $('error').hidden = true
    setStatus($('stick-status'), 'After reformatting the stick, choose it again here.')
    refresh()
    showFormatHelp().scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  const menu = document.querySelector('.t-menu-btn')
  menu?.addEventListener('click', () => {
    const open = document.documentElement.classList.toggle('menu-open')
    menu.setAttribute('aria-expanded', String(open))
  })
  for (const b of document.querySelectorAll('.change')) {
    b.addEventListener('click', () => {
      state.focus = b.dataset.step
      if (state.focus === 'step-what') for (const r of document.querySelectorAll('#catalogue input')) r.checked = false
      state.finished = false
      $('done').hidden = true
      refresh()
    })
  }
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const text = $(b.dataset.copy).textContent.trim()
      try {
        await navigator.clipboard.writeText(text)
        b.textContent = 'Copied'
      } catch {
        const range = document.createRange()
        range.selectNodeContents($(b.dataset.copy))
        getSelection().removeAllRanges()
        getSelection().addRange(range)
        b.textContent = 'Selected'
      }
      setTimeout(() => (b.textContent = 'Copy'), 2000)
    })
  }
  refresh()
}

// Local development only. Add ?demo=done to the address to see the finished screen and the
// thank-you panel without writing a stick, and &reset=1 to forget an earlier "Not now".
if (location.hostname === 'localhost' && params.get('demo') === 'done') {
  if (params.get('reset')) {
    try {
      localStorage.removeItem(THANKS_KEY)
    } catch {}
  }
  showDone([
    ['Written to', 'DEMO STICK'],
    ['What was written', '979 files, 9.0 GB'],
    ['Time taken', '6 minutes'],
  ])
}

// Local development only: lets a test hand Project mkstick a file without the file dialog.
if (location.hostname === 'localhost') window.__mkstick = { state, useFile, choose }

init()
