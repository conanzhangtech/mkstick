// Runs the same engine as the web page, from the command line.
// node test/flash-cli.mjs <image.iso> <target folder>
import { createHash } from 'node:crypto'
import { buildPlan, writePlan, verifySizes } from '../public/lib/flash.js'
import { FileSource, NodeDir } from './nodefs.js'

const [, , iso, target] = process.argv
if (!iso || !target) {
  console.error('usage: node test/flash-cli.mjs <image.iso> <target folder>')
  process.exit(2)
}
const source = new FileSource(iso)
const t0 = Date.now()
const plan = await buildPlan(source, process.argv[4] ? { patch: { name: process.argv[4], repo: process.argv[5] } } : {})
console.log(`${plan.kind} / ${plan.format} / label "${plan.label}"`)
console.log(`${plan.outputs.length} files, ${(plan.totalBytes / 1e9).toFixed(2)} GB, plan took ${Date.now() - t0} ms`)
for (const n of plan.notes) console.log('note:', n)
if (plan.skipped.length) console.log('skipped:', plan.skipped.length, plan.skipped.slice(0, 5))

const hash = createHash('sha256')
const result = await writePlan(source, plan, new NodeDir(target), { hasher: hash })
console.log(JSON.stringify(result), `${((Date.now() - t0) / 1000).toFixed(0)} s`)
if (result.hashed) console.log('sha256', hash.digest('hex'))
const wrong = await verifySizes(plan, new NodeDir(target))
console.log(wrong.length ? `WRONG SIZES: ${wrong.join(', ')}` : 'all sizes match')
