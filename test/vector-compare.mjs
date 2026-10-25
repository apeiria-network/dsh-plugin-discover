#!/usr/bin/env node
/**
 * Compare lexical and vector rankings on the 25-query test set. Test-only
 * since v2.3: a human evaluation aid for experiments — the vector on/off
 * decision is made on the repo-recall-20 and real-usage-v3 sets. This prints
 * the top three side by side; it does not pretend to automate relevance.
 *
 *   node test/vector-compare.mjs --index-dir <dir> [--mode fields|readme] [--max 3]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, search } from '../lib/search.js'
import { disposeVectorRuntime } from '../lib/vector.js'
import { detectRuntimeVersion } from '../lib/compat.js'

const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const indexDir = valueOf('--index-dir') || process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR
const requestedMode = valueOf('--mode') || 'balance'
const mode = requestedMode === 'balance' ? 'fields' : requestedMode === 'high' ? 'readme' : requestedMode
const max = Number(valueOf('--max')) || 20
if (!indexDir) {
  console.error('usage: node test/vector-compare.mjs --index-dir <dir> [--mode off|balance|high] [--max 3]')
  process.exit(2)
}
const suite = JSON.parse(readFileSync(new URL('./acceptance.queries.json', import.meta.url), 'utf8'))
const records = readRecords(resolve(indexDir))
if (!records) {
  console.error(`no usable index in ${resolve(indexDir)}`)
  process.exit(1)
}
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })
const base = { limit: 10, indexDir: resolve(indexDir), disposeClient: false }

async function run(item, vectorMode) {
  const started = Date.now()
  const value = await search(searcher, {
    ...base,
    query: item.query,
    queryAlts: item.alts,
    vectorMode,
  })
  return { value, ms: Date.now() - started }
}

let nonEmpty = 0
let changed = 0
const positive = suite.positive.slice(0, max)
for (const item of positive) {
  const lexical = await run(item, 'off')
  const vector = await run(item, mode)
  if (!vector.value.noMatch) nonEmpty += 1
  const lexicalTop = lexical.value.results.slice(0, 3).map(result => result.name)
  const vectorTop = vector.value.results.slice(0, 3).map(result => result.name)
  const differs = JSON.stringify(lexicalTop) !== JSON.stringify(vectorTop)
  if (differs) changed += 1
  console.log(`\n${item.query}`)
  console.log(`  lexical (${lexical.ms} ms): ${lexicalTop.join(', ') || '(noMatch)'}`)
  console.log(`  ${mode} (${vector.ms} ms): ${vectorTop.join(', ') || '(noMatch)'} ${JSON.stringify(vector.value.vector)}`)
  if (differs) console.log('  → top-3 changed')
}

let negativeEmpty = 0
const negative = suite.negative.slice(0, 5)
for (const item of negative) {
  const vector = await run(item, mode)
  if (vector.value.noMatch) negativeEmpty += 1
  console.log(`\n${item.query}`)
  console.log(`  ${mode}: ${vector.value.noMatch ? 'noMatch' : vector.value.results.slice(0, 3).map(result => result.name).join(', ')}`)
}

disposeVectorRuntime()
console.log(`\n${mode}: non-empty ${nonEmpty}/${positive.length}; top-3 changed ${changed}/${positive.length}`)
if (negative.length > 0) console.log(`${mode}: negative noMatch ${negativeEmpty}/${negative.length}`)
console.log('Human check: did the vector top-3 keep or improve a usable result?')
process.exitCode = 0
