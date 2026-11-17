# mkstick: project documentation

mkstick makes a bootable Windows or Linux USB stick from a web page, with nothing to install. This document explains what it does, how it is built, how to run and deploy it, and what is still open.

- Codename: Project mkstick, said "make stick". It was called Flasher until 15 November 2026.
- Staging site: https://mkstick.czt.sh
- Source code: https://github.com/conanzhangtech/mkstick
- Public write-up: https://czt.sh/projects/mkstick
- Licence: MIT
- Status on 17 November 2026: live. Writing to a real USB stick through the browser's folder picker has been tested and works.

## Contents

1. [What it does](#1-what-it-does)
2. [How a stick gets made](#2-how-a-stick-gets-made)
3. [Architecture](#3-architecture)
4. [The page](#4-the-page)
5. [The engine](#5-the-engine)
6. [The Worker](#6-the-worker)
7. [Windows download links](#7-windows-download-links)
8. [Security](#8-security)
9. [Running, testing and deploying](#9-running-testing-and-deploying)
10. [Design and wording rules](#10-design-and-wording-rules)
11. [Limits](#11-limits)
12. [What has been tested](#12-what-has-been-tested)
13. [Open items](#13-open-items)
14. [Decisions and why](#14-decisions-and-why)

## 1. What it does

A person picks a system, plugs in a stick and presses a button. mkstick writes the installer's files to the stick. It does the job of an app such as Rufus, from a web page, so it works the same way on Windows, Mac and Linux.

| System | Where the image comes from |
|---|---|
| Windows 11 (x64 and Arm), Windows 10 | Microsoft. The person's browser downloads the ISO from Microsoft, then they choose that file. |
| Windows Server 2025, 2022 and 2019 (evaluation) | Microsoft's Evaluation Center. The person downloads the ISO there, then chooses that file. |
| Ubuntu Desktop and Server 26.04 and 24.04, Debian network installer, Debian Live (GNOME), Linux Mint (Cinnamon), Arch Linux, Alpine Linux | The publisher's own server, read through mkstick's Worker in pieces and checked against the publisher's SHA-256. |
| Rocky Linux 9 and 10, AlmaLinux 9 and 10 (network installers) | The publisher's own server, in the same way. Their boot menu is changed while writing (section 5). |
| Any other installer | An ISO file the person already has. |

mkstick stores no disc images. It has no accounts, cookies or analytics.

## 2. How a stick gets made

A modern PC (UEFI) starts from a FAT32 stick that holds the installer's files. So mkstick does not write a raw disk image. It copies files.

1. **Pick a system.** The list comes from `/api/catalogue`.
2. **Get the installer.**
   - Windows: the page offers a direct download from Microsoft when it holds a fresh link, and otherwise shows how to get the file from Microsoft's page. The person then chooses the downloaded file. The file is read on their computer and never uploaded.
   - Linux: nothing to do. The image is fetched while it is written.
3. **Choose the stick.** The browser's folder picker opens and the person picks the stick. mkstick refuses a folder that is not empty, unless it holds part of the same image from an earlier run.
4. **Write.** Files are written in the order they sit in the image. Windows' `install.wim` is too big for FAT32, so it is split into `install.swm`, `install2.swm` and so on. At the end every file's size is checked, and for Linux the whole image's SHA-256 is compared with the publisher's.

A web page cannot format a drive. If the stick is not FAT32, or not empty, the person formats it themselves and the page shows how.

## 3. Architecture

```
Browser (Chrome or Edge)                         Cloudflare Worker                 Others
┌──────────────────────────────┐   /api/catalogue   ┌───────────────────┐   SHA256SUMS   ┌────────────────────┐
│ index.html, app.js, style.css │ ─────────────────▶ │ catalogue          │ ─────────────▶ │ releases.ubuntu.com │
│                               │   /mirror/… Range  │ mirror pass-through│ ─────────────▶ │ cdimage.debian.org  │
│ lib/udf.js      read Windows  │ ─────────────────▶ │                    │                └────────────────────┘
│ lib/iso9660.js  read Linux    │   /api/windows/…   │ Windows links (KV) │ ◀── POST with secret ── GitHub job ──▶ Microsoft
│ lib/wim.js      split         │ ─────────────────▶ │ header and footer  │ ─────────────▶ czt.sh
│ lib/flash.js    plan, write   │                    │ security headers   │
│ lib/source.js   read bytes    │                    └───────────────────┘
└───────────────┬──────────────┘
                │ File System Access API
                ▼
           USB stick (FAT32)
```

There is no build step and no framework. The page is plain HTML, CSS and JavaScript modules.

| Path | What it is |
|---|---|
| `public/index.html`, `app.js`, `style.css` | The page |
| `public/lib/` | The engine (section 5) |
| `public/vendor/sha256.umd.min.js` | hash-wasm 4.12 (MIT), unchanged |
| `public/fonts/schibsted-grotesk.woff2` | Schibsted Grotesk (SIL Open Font Licence) |
| `src/index.js` | The Worker (section 6) |
| `jobs/`, `.github/workflows/links.yml` | The scheduled job that fetches Windows links (section 7) |
| `test/flash-cli.mjs`, `test/nodefs.js` | Runs the engine from the command line |
| `test/security-check.mjs` | Checks a running site against the security rules |
| `test/proof/` | Screenshots of sticks made by the engine starting in a virtual PC |
| `wrangler.jsonc` | Worker settings: routes, rate limits, link storage |

## 4. The page

`app.js` keeps one `state` object and one `refresh()` function that redraws from it.

- Four steps: `step-what`, `step-files`, `step-stick`, `step-write`. Each has `data-state` of `todo`, `current` or `done`. Only the current step is open. A finished step shows a one-line summary and a **Change** link.
- **Errors say what to do.** A stick that is not empty, or cannot be opened, opens the formatting steps. A write error that is about the stick offers **Show me how to reformat**.
- **While writing**, a warning asks the person to let it finish. The browser also asks before the tab is closed or refreshed, and the screen is kept awake.
- **Two tabs** can write to different sticks at once. A Web Lock named after the stick stops two tabs writing to the same one. Chrome only gives the stick's name, so two sticks with the same name count as one.
- **Test folder.** "Try it with a test folder" writes to the browser's private storage (OPFS) and not to a drive. `?target=opfs` starts in that mode. It is how the flow is tested without a stick.
- **Unsupported browsers** (Safari, Firefox, phones) see a notice. Everything except choosing a real stick still works.
- **Header and footer** are the main site's own (section 6).

### Support and donations

Project mkstick stays free, with no adverts, paid features or tracking. Donations are asked for in three quiet places:

- **The support section** (`#support`) lists GitHub Sponsors, Ko-fi, PayPal and two USDT addresses. Each address has a Copy button and a QR code. The QR codes are static SVG files in `public/qr/`. `tools/make-qr.mjs` draws them from the addresses in `index.html` and reads each one back to prove it holds exactly that address, so run it again if an address ever changes.
- **The thank-you panel** appears under "Your stick is ready" after a write succeeds, and never during a write or after a failure. "Not now" hides it for 30 days. That date is the only thing the page keeps in the browser (`localStorage`, key `mkstick-thanks-dismissed`), and the page works the same if storage is blocked.
- **The supporters wall** reads `public/supporters.json`, which is edited by hand. Each entry has a `name`, and may have an `https` `link` and a `tier`:

```json
[
  { "name": "Ada Lovelace", "link": "https://example.com", "tier": "Sponsor" },
  { "name": "A friend" }
]
```

An empty list shows "Be the first supporter". Nothing is fetched from GitHub or any other site.

On a local copy, `?demo=done` shows the finished screen and the thank-you panel without writing a stick, and `?demo=done&reset=1` also forgets an earlier "Not now".

## 5. The engine

All of it runs in the browser and in Node, because it only needs "something to read bytes from" and "something shaped like a folder".

| File | Job |
|---|---|
| `source.js` | `BlobSource` reads a local file in slices. `HttpSource` reads a remote file with Range requests and keeps one download open while the reads are in order. `CachedSource` remembers recent small reads. |
| `udf.js` | Reads UDF, the format of Windows ISOs: anchor at sector 256, partition and logical volume descriptors, file set, file entries, short and long allocation descriptors, inline data. |
| `iso9660.js` | Reads ISO 9660, the format of Linux ISOs. Uses Rock Ridge names when present (full length), then Joliet, then plain names. Reads symbolic links so they can be copied as files. |
| `wim.js` | Plans the split of `install.wim`. It copies each stored item as it is, compressed, into a part and writes a new header and index for each part. Nothing is decompressed. Image descriptions go in part 1. |
| `flash.js` | `buildPlan()` turns an image into a list of files to write, each a list of byte ranges or literal bytes. `writePlan()` writes them, feeds the checksum in image order, groups small writes, and skips files that are already there with the right size. `verifySizes()` checks the result. |

Things worth knowing:

- **One pass.** Files are written in image order, and the gaps between them are read too, so the whole image is hashed while it is written. A Linux run through the Worker takes about ten requests.
- **Resume.** Chrome writes each file to a temporary file and renames it when it closes. So a file on the stick with the right size is complete, and a second run can skip it. A resumed run cannot give a whole-image checksum.
- **Symbolic links.** FAT32 has none. A link to a file, or to a folder under 64 MB, is copied as real files. A link to itself or a parent is skipped.
- **Names from an image are not trusted** (section 8).
- **What cannot be split.** ESD and "solid" Windows images, and any single non-WIM file over 4 GB.

### Boot menu fixes

Most installers start from a copied stick as they are. A few look for their own disc by its name, and a stick carries a different name. `public/lib/patches.js` holds the small rewrites for those, and the Worker marks which entries need one (`patch` in the catalogue).

| Installer | What it looked for | What the page changes |
|---|---|---|
| Rocky Linux, AlmaLinux (anaconda) | The disc named in `grub.cfg`, for both the search and `inst.stage2` | The search uses the installer's own file, and `inst.stage2` points at the publisher's package server. These are network installers, so the PC needs internet during setup. |
| Arch Linux (archiso) | The ISO's built-in ID, `archisosearchuuid` | `archisolabel` with the disc's name, `ARCH_202611` at the time of writing. It has 11 characters, which is the most a FAT32 label can have, so the person formats the stick with that name. The page shows the name before the stick is chosen. |

The rewrite changes only those lines. The checksum is still taken from the image as downloaded, because the engine hashes the whole image in order and the rewritten files are only what is written.

## 6. The Worker

`src/index.js`. Every request passes through it (`run_worker_first: true`), so every answer carries the security headers.

| Route | Method | What it does |
|---|---|---|
| `/api/catalogue` | GET | The list of systems. Linux file names, sizes and SHA-256 are read from each publisher's `SHA256SUMS` and kept for an hour. |
| `/api/windows/languages?product=&arch=` | GET | The languages a direct Windows link is held for. Empty if none. |
| `/api/windows/link?product=&arch=&lang=` | GET | A stored Microsoft link, or 404 with the address of Microsoft's download page. |
| `/api/windows/links` | POST | The scheduled job hands over fresh links. Needs the secret. |
| `/mirror/<id>/<path>.iso` | GET | Passes a piece of a Linux image through from its publisher. |
| anything else | GET | The static page, with the main site's header and footer put in. |

**Mirror pass-through.** Linux mirrors do not let a web page read their files (no CORS headers), so the Worker fetches the piece and passes it on. It only reaches the servers in `MIRRORS`, only serves `.iso` files, needs a Range header, and only answers mkstick's own page. A publisher's server now and then ignores the Range header and starts sending the whole image. The Worker drops that answer and asks again.

**Header and footer.** `siteFrame()` fetches the main site (`MAIN_SITE`, https://czt.sh) once an hour, takes its `header.site-header` and `footer.site-footer`, cleans them, and `HTMLRewriter` puts them into the page. Links and labels follow the main site by themselves. Their styles live in `public/style.css` and do not follow. If the main site cannot be reached, the copy in `index.html` is shown.

**Settings** (`wrangler.jsonc`):

- `ratelimits`: `API_LIMIT` 60 a minute, `MIRROR_LIMIT` 600 a minute, `WRITE_LIMIT` 10 a minute, each per visitor address. Cloudflare's limiter is approximate and counts per location.
- `kv_namespaces`: `LINKS`, where Windows links are kept for 23 hours.
- Secret `LINKS_TOKEN`: what the job must send. Set with `wrangler secret put LINKS_TOKEN`.

## 7. Windows download links

Microsoft does not allow other sites to hand out Windows, and its download servers do not let a web page read the file. So the file always travels from Microsoft to the person's browser, and the person then chooses it.

What mkstick can do is skip the visit to Microsoft's page, by holding the same time-limited link that page would give. Getting that link has three facts behind it, all found by testing:

1. Microsoft **rejects** link requests from Cloudflare's network, every time. This also happens when the session was opened somewhere else.
2. Microsoft **accepts** them from GitHub's runners and from a home connection.
3. From one address, Microsoft answers about **eight** link requests for one Windows version, then refuses the rest for a while.

So the links are fetched by a scheduled job and stored:

```
GitHub Actions (every 6 hours, one runner per Windows version)
  jobs/fetch-links.mjs ── asks Microsoft for 8 languages ──▶ Microsoft
            │
            └── POST /api/windows/links, Bearer secret ──▶ Worker ──▶ KV (23 hours)

Page ── GET /api/windows/link ──▶ Worker ──▶ KV ──▶ link ──▶ browser downloads from Microsoft
```

- `jobs/mslink.js` replays what Microsoft's download page does: it opens a session, lists the languages, and asks for the link. It was written from how the page behaves and copies no other tool's code.
- `jobs/fetch-links.mjs` fetches English, English International, Chinese Simplified, Chinese Traditional, French, German, Japanese and Spanish for one version, and posts them.
- `.github/workflows/links.yml` is the workflow. It runs three runners, one each for Windows 11 x64, Windows 11 Arm and Windows 10, because each runner has its own address.
- The job runs in this repository's GitHub Actions. It needs two repository secrets: `MKSTICK_URL` (the site) and `MKSTICK_TOKEN` (the same value as the Worker's `LINKS_TOKEN`). The logs show file names only, never the links or the secret.
- If no fresh link is held, or the person's language is not one of the eight, the page shows how to get the file from Microsoft's page.

Links last about 24 hours. Four runs a day leave room for one or two failed runs.

## 8. Security

The full list is in [SECURITY.md](../SECURITY.md). The main points:

| Risk | Protection |
|---|---|
| Script injection | Content-Security-Policy starting from `default-src 'none'`. Scripts, styles and fonts come from this site only. No inline scripts, styles or handlers. Trusted Types are required, so the page cannot turn text into HTML. Data is shown with `textContent`. |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| Wiping the wrong drive | A web page cannot format or erase a disk. mkstick only adds files, and refuses a folder that is not empty. |
| A hostile disc image | Names with `..`, empty parts or characters FAT32 forbids are left out. Folder listings, file counts and index sizes have upper limits. |
| A tampered Linux download | The whole image is hashed and compared with the publisher's SHA-256. |
| A fake Windows link | A link is checked to be `https` on `microsoft.com` when it is stored, when it is served, and by the page before it is followed. |
| Someone else writing links | The write route needs a secret, compared in constant time. It has its own rate limit and a size limit, and every field is checked. |
| The pass-through used as an open proxy | Two named servers, `.iso` only, Range required, mkstick's own page only. |
| The main site's markup | Cut down before use: no scripts, frames, forms, inline handlers or styles, and only `https` and `mailto` links. |
| Flooding | Rate limits per visitor address. |
| Tracking and leaks | No accounts, cookies, analytics or third-party requests. The chosen ISO never leaves the computer. |

Run the checks against any running copy:

```bash
node test/security-check.mjs https://mkstick.czt.sh
```

No site can be proved unhackable. These are the things that stay outside mkstick's control:

- A compromised publisher that gives out a bad image with a matching checksum.
- A compromised browser, computer, Cloudflare account or GitHub account. Turn on two-step login for both accounts.
- Windows images are not checked against a list, because Microsoft publishes none that a program can read. The page shows the SHA-256 so it can be compared by hand.

## 9. Running, testing and deploying

Run it locally:

```bash
npx wrangler dev -c mkstick.czt.sh/wrangler.jsonc --port 8794
```

Run the engine on a real image, into an empty folder:

```bash
node test/flash-cli.mjs path/to/image.iso path/to/empty/folder
```

Check a Windows result with wimlib:

```bash
wimlib-imagex verify sources/install.swm --ref="sources/install*.swm"
```

Check the security rules:

```bash
node test/security-check.mjs http://localhost:8794
```

Deploy to staging. The login has two accounts, so the account is named:

```bash
CLOUDFLARE_ACCOUNT_ID=<your account id> npx wrangler deploy
```

Run the Windows links job by hand:

```bash
gh workflow run links.yml -R conanzhangtech/mkstick
```

To boot-test a stick without a PC: make a FAT32 disk image, write to it with `flash-cli.mjs`, and start it in QEMU with the UEFI firmware that ships with QEMU.

To host mkstick somewhere else: change `routes` in `wrangler.jsonc`, change or remove `MAIN_SITE`, create a KV namespace and put its id in `kv_namespaces`, and set `LINKS_TOKEN`.

## 10. Design and wording rules

- The frame is the main site's: same header, footer, 1,320px container, Schibsted Grotesk, ink `#10231c`, jade `#0b6b52`, sun yellow `#ffd23f`, hairlines and 6px controls.
- Under that frame mkstick has its own bar with its mark and links, and a solid jade introduction.
- No gradients, glows, shadows, blur, emoji headings or coloured side borders.
- UK English. Join related points into one natural sentence. Do not write clipped pairs of short sentences.
- Every error says what happened and what to do next.

## 11. Limits

- Chrome or Edge on a computer. Safari, Firefox and phones cannot write to a drive from a web page.
- The stick must already be FAT32, and empty.
- The stick starts UEFI PCs only, which leaves out some machines from before 2012.
- A Linux image with a single file over 4 GB cannot be written. Each new image must be boot-tested before it is listed.
- ESD and solid Windows images cannot be split.
- Direct Windows links cover eight languages. Others use Microsoft's page.
- No Mac installers. Apple only allows those to be made on a Mac.

## 12. What has been tested

| Test | Result |
|---|---|
| Windows 11 x64 ISO (9 GB) through the engine | 979 files. Every file matches the ISO except `install.wim`, which becomes three parts. |
| The split, checked by wimlib | Verified. Part sizes equal wimlib's own split on a small image. |
| Windows 11 stick image in QEMU | Setup starts and lists all editions, so it reads the split file. |
| Debian and Ubuntu Server stick images in QEMU | Both reach their installers. Both checksums match. |
| Alpine Linux 3.24 stick image in QEMU | Reaches the login prompt. Checksum matches. |
| Rocky Linux 10 network installer stick image in QEMU | The changed boot menu starts the installer, which fetches its second stage from Rocky's server and shows its welcome screen. Checksum matches. |
| Arch Linux stick image in QEMU, formatted with the name `ARCH_202611` | Starts and logs in as root. Without that name it stops with "device not found". Checksum matches. |
| A real USB stick, written from the browser through the folder picker | Works. |
| Debian on the live site, into the test folder | 1,073 files in about 35 seconds, checksum matches. |
| The Windows links job | 24 links stored (three versions, eight languages). A stored link answers from Microsoft. |
| `test/security-check.mjs` on staging | All checks pass. |

## 13. Open items

- Not yet boot-tested: Ubuntu 26.04, Debian Live, Linux Mint, AlmaLinux and Rocky Linux 9, Windows Server (the ISO from the Evaluation Center), Windows 10 and Arm ISOs. They use the same method as the systems that were tested.
- Arch Linux only starts from a stick named after its ISO (`ARCH_202611`). If a stick is not named that, the boot stops at a shell with "device not found".
- The Evaluation Center page addresses for Windows Server are written from the pattern Microsoft uses. Check them now and then.
- The one-click Windows download has not been followed by a full download and write in the browser.
- Cloudflare adds its Web Analytics script to the page. The security policy blocks it, which leaves an error in the browser console. Turn it off for this hostname in the dashboard.

## 14. Decisions and why

| Decision | Why |
|---|---|
| Copy files to FAT32, not write a raw image | Browsers do not allow raw writes to a drive, and WebUSB cannot reach storage devices. |
| Never host, cache or proxy Windows ISOs | Microsoft's terms do not allow it, and it would put the Cloudflare account at risk. |
| Read Linux images from publishers through a Worker | No storage to pay for or keep up to date. Mirrors send no CORS headers, so a pass-through is needed. |
| Write an own WIM splitter | No WebAssembly build of wimlib exists, and a split only moves compressed items, so it needs no decompression and little memory. |
| Fetch Windows links from GitHub | Microsoft rejects Cloudflare and accepts GitHub's runners. |
| One open step at a time | The first version showed everything at once and was hard to follow. |
| Read the header and footer from the main site | So a change there does not have to be repeated here. |
