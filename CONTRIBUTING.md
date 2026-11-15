# Contributing

Bug reports and fixes are welcome.

## Before you open an issue

Say which browser and system you used, which image you chose, and what the page said. If a stick did not start a PC, say the PC's make and model.

## Changing the code

1. Run the page with `npx wrangler dev`.
2. Test with `?target=opfs` in the address, or with "Use a test folder inside this browser".
3. Run `node test/flash-cli.mjs image.iso empty-folder` on a real image and check the result.
4. Keep the code plain: no framework, no build step, no new dependency without a reason.

## Adding a Linux image

Add it to `LINUX` in `src/index.js` and its server to `MIRRORS`. Before it is listed, make a stick and check that a PC starts from it. An image with a single file over 4 GB cannot be supported.

## Style

The page is written in UK English, in short plain sentences. Controls have 6px corners. There are no gradients, shadows or animations.
