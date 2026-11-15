# Project mkstick

Full documentation: [docs/PROJECT.md](docs/PROJECT.md).

Makes a bootable Windows or Linux USB stick from a web page. No app to install. Free and open source under the MIT licence.

Site: https://staging.mkstick.czt.sh

Write-up: https://czt.sh/projects/mkstick

## How it works

- The page reads a disc image (ISO) and copies its files to a FAT32 stick the user picks. Chrome and Edge allow this through the File System Access API. Safari, Firefox and phones do not.
- Windows images come from Microsoft. The page links to Microsoft's download page, the user downloads the ISO there and then chooses that file. Microsoft's servers do not let a web page read the download directly, so this step cannot be skipped.
- A scheduled job (`jobs/`) fetches official Windows download links from Microsoft every six hours and hands them to the Worker, which keeps them for 23 hours. The page uses a stored link for a one-click download. Microsoft rejects these requests from Cloudflare's network and accepts them from GitHub's runners, which is why a job does it.
- Linux images are read in pieces through the Worker from the publisher's own server, and checked against the publisher's SHA-256.
- `install.wim` is larger than FAT32 allows, so it is split into `install.swm`, `install2.swm` and so on. Nothing is decompressed.
- The Worker stores no disc images.

## Layout

| Path | What it is |
|---|---|
| `public/index.html`, `app.js`, `style.css` | The page |
| `public/lib/udf.js` | Reads Windows discs (UDF) |
| `public/lib/iso9660.js` | Reads Linux discs (ISO 9660, Rock Ridge, Joliet) |
| `public/lib/wim.js` | Plans the `install.wim` split |
| `public/lib/flash.js` | Builds the list of files to write, then writes them |
| `public/lib/source.js` | Reads a local file or a remote file in pieces |
| `public/vendor/sha256.umd.min.js` | hash-wasm 4 (MIT), for the checksum |
| `public/fonts/` | Schibsted Grotesk (SIL Open Font Licence) |
| `src/index.js` | Worker: catalogue, Microsoft link, mirror pass-through |
| `jobs/` | Scheduled job that fetches Windows download links from Microsoft |
| `docs/PROJECT.md` | Full project documentation |
| `test/security-check.mjs` | Checks a running site against the security rules |
| `test/flash-cli.mjs` | Runs the same engine from the command line |
| `test/proof/` | Screenshots of sticks made by the engine starting in a virtual PC |

## Header and footer

The Worker reads the header and footer from the main site (`MAIN_SITE` in `src/index.js`) once an hour and puts them into the page, so links and labels follow the main site. Their styles are in `public/style.css` and are not synced. If the main site cannot be reached, the copy in `index.html` is shown. To run mkstick under another site, change `MAIN_SITE` or remove `siteFrame`.

## Run it

```bash
npx wrangler dev -c mkstick.czt.sh/wrangler.jsonc --port 8794
```

Add `?target=opfs` to the address to write to a private folder inside the browser instead of a stick. This is for testing.

```bash
node test/flash-cli.mjs path/to/image.iso path/to/empty/folder
```

## Deploy

```bash
npx wrangler deploy
```

Change `routes` in `wrangler.jsonc` to your own domain first. If your login has more than one account, set `CLOUDFLARE_ACCOUNT_ID`.

## Security

See [SECURITY.md](SECURITY.md). In short: a strict Content-Security-Policy, no third-party requests, rate limits, a locked-down pass-through, and no trust in file names read from a disc image.

## Limits

- Chrome or Edge on a computer.
- The stick must already be FAT32. A web page cannot format a drive.
- The stick starts UEFI PCs only.
- A Linux image with a single file over 4 GB cannot be written.
- ESD and "solid" Windows images cannot be split.
