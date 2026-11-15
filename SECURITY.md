# Security

## Reporting a problem

Please report security problems in private, not in a public issue. Contact the maintainer through https://github.com/conanzhangtech. Say what you found and how to repeat it. You will get a reply.

## What mkstick protects against

| Risk | What mkstick does |
|---|---|
| Wiping the wrong drive | A web page cannot format or erase a disk. mkstick only adds files to the folder the user picks, and refuses a folder that is not empty. |
| A hostile disc image | File names from an image are never trusted. Names with `..`, empty parts or characters FAT32 forbids are left out. Folder listings, file counts and index sizes have upper limits. |
| A tampered Linux download | The whole image is hashed as it is written and compared with the publisher's SHA-256. |
| Script injection | The page sets text with `textContent`, never with HTML from data. A strict Content-Security-Policy allows scripts, styles and fonts from this site only, and requires Trusted Types, so the page cannot turn text into HTML. |
| Clickjacking | The page cannot be shown in a frame. |
| A fake Windows link | A link is checked to be an `https` address on `microsoft.com` when it is stored, when it is served, and by the page before it is followed. |
| Someone else writing links | Only the scheduled job can write. The route needs a secret, compared in constant time, and has its own rate limit and size limit. Every field is checked. |
| The main site's header and footer | The markup is cut down before it is used: no scripts, frames, forms, inline handlers or styles, and only `https` and `mailto` links. |
| The pass-through used as an open proxy | It reaches two named servers only, serves `.iso` files only, needs a Range header, and answers mkstick's own page only. |
| Flooding | Requests are limited per visitor address. |
| Leaked data | There are no accounts, cookies, analytics or stored files. The ISO a user chooses never leaves their computer. |

## Checking it

```bash
node test/security-check.mjs https://staging.mkstick.czt.sh
```

This runs about 45 checks against a running copy: headers, the page's markup, methods, the pass-through, the API and the write route.

## What it does not protect against

- A compromised publisher. If Ubuntu's or Debian's own server gave out a bad image and a matching checksum, mkstick could not tell.
- Windows images are not checked against a list, because Microsoft does not publish one that a program can read. mkstick shows the SHA-256 so the user can compare it with Microsoft's download page.
- A compromised browser or computer.
- A compromised Cloudflare or GitHub account. Use two-step login on both, and keep the job's secret out of logs and code.

## Third-party code

- `public/vendor/sha256.umd.min.js` is hash-wasm 4.12 (MIT), copied from the npm package unchanged.
- `public/fonts/schibsted-grotesk.woff2` is Schibsted Grotesk (SIL Open Font Licence).
