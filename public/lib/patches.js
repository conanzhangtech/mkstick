// A few installers look for their own disc by its name. A stick copied from the disc has a different
// name, so those installers would not find themselves. For them, mkstick changes the lines in the
// boot menu that name the disc, and nothing else.
//
// anaconda (Rocky Linux, AlmaLinux): the menu says "search for the disc called X" and "load the
// installer from the disc called X". It now searches for the installer's own file instead, and
// loads the installer from the publisher's package server, which is what these small
// "network installer" images are made for.
//
// archiso (Arch Linux): the boot entry says "find the disc by its built-in ID", which a stick does
// not have. It now says "find the drive called X", where X is the disc's own name. That name fits
// in the 11 characters a FAT32 stick allows, so the stick has to be formatted with that name.

const RULES = {
  anaconda: {
    files: /^(efi\/boot\/grub\.cfg|boot\/grub2?\/grub\.cfg)$/i,
    apply(text, { repo }) {
      if (!repo || !/^https:\/\//.test(repo)) return text
      return text
        .replace(/search\s+--no-floppy\s+--set=root\s+-l\s+'[^'\n]*'/g, 'search --no-floppy --set=root --file /images/pxeboot/vmlinuz')
        .replace(/inst\.stage2=hd:LABEL=\S+/g, `inst.stage2=${repo}`)
    },
  },
  archiso: {
    files: /^loader\/entries\/[^/]*archiso[^/]*linux\.conf$/i,
    apply(text, { label }) {
      if (!label || !/^[A-Za-z0-9_-]{1,11}$/.test(label)) return text
      return text.replace(/archisosearchuuid=\S+/g, `archisolabel=${label}`)
    },
  },
}

/** Returns a function that rewrites one file's text, or null when this file is left alone. */
export function patchFor(patch, path) {
  const rule = patch && RULES[patch.name]
  if (!rule || !rule.files.test(path)) return null
  return (text) => rule.apply(text, patch)
}
