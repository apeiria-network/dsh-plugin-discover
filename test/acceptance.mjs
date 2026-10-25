#!/usr/bin/env node
/**
 * The 40-query test set: 20 real needs + 20 out-of-domain needs that should
 * have no result. Test-only since v2.3 — smoke and experiment runs, not
 * acceptance; evaluation uses repo-recall-20 and real-usage-v3. Reports the
 * automatic gates (non-empty rate, noMatch rate) and prints the top three per
 * query.
 *
 *   node test/acceptance.mjs --index-dir <dir>
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, search } from '../lib/search.js'
import { detectRuntimeVersion } from '../lib/compat.js'

const args = process.argv.slice(2)
const indexDirIndex = args.indexOf('--index-dir')
const indexDir = indexDirIndex >= 0 ? args[indexDirIndex + 1] : process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR
if (!indexDir) {
  console.error('usage: node test/acceptance.mjs --index-dir <dir>')
  process.exit(2)
}
const suite = JSON.parse(readFileSync(new URL('./acceptance.queries.json', import.meta.url), 'utf8'))
const records = readRecords(resolve(indexDir))
if (!records) {
  console.error(`no usable index in ${resolve(indexDir)}; run: node lib/cli.js build --index-dir ${indexDir}`)
  process.exit(1)
}
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })

function run(item) {
  return search(searcher, {
    query: item.query,
    queryAlts: item.alts,
    limit: 10,
    preset: 'balanced',
    indexDir: resolve(indexDir),
  })
}

let nonEmpty = 0
console.log('POSITIVE (need: at least 18 non-empty; human check: one usable in top 3)\n')
for (const [index, item] of suite.positive.entries()) {
  const value = await run(item)
  if (!value.noMatch) nonEmpty += 1
  const top = value.results.slice(0, 3).map(result => result.name).join(', ')
  console.log(`${String(index + 1).padStart(2)}. ${value.noMatch ? 'EMPTY ' : 'ok    '} ${item.query}`)
  console.log(`    -> ${top || '(noMatch)'}`)
}
console.log(`\nnon-empty: ${nonEmpty}/${suite.positive.length} (pass >= 18)\n`)

let emptyNegative = 0
const negativePass = Math.ceil(suite.negative.length * 0.8)
console.log(`NEGATIVE (need: at least ${negativePass} noMatch)\n`)
for (const [index, item] of suite.negative.entries()) {
  const value = await run(item)
  if (value.noMatch) emptyNegative += 1
  const top = value.results.slice(0, 3).map(result => result.name).join(', ')
  console.log(`${String(index + 1).padStart(2)}. ${value.noMatch ? 'noMatch' : 'LEAK   '} ${item.query}`)
  if (!value.noMatch) console.log(`    -> ${top}`)
}
console.log(`\nnoMatch: ${emptyNegative}/${suite.negative.length} (pass >= ${negativePass})`)

const ok = nonEmpty >= 18 && emptyNegative >= negativePass
console.log(`\n${ok ? 'PASS' : 'FAIL'} — automatic gates only; judge the top-3 column by hand.`)
process.exitCode = ok ? 0 : 1
