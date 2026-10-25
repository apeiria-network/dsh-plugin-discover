#!/usr/bin/env node
/**
 * Frozen 20-repo recall/regression set. Runs the exact same queries in
 * off / balance / high and records expected-plugin ranks. No production code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, search } from '../lib/search.js'
import { detectRuntimeVersion } from '../lib/compat.js'
import { ALGORITHM_VERSION, disposeVectorRuntime } from '../lib/vector.js'

const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const indexDir = valueOf('--index-dir') || process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR
const outDir = resolve(valueOf('--out-dir') || 'reports')
const requestedMode = valueOf('--mode') || 'off'
if (!['off', 'balance', 'high'].includes(requestedMode)) {
  console.error('usage: node test/repo-recall.mjs --index-dir <dir> --mode off|balance|high [--out-dir reports]')
  process.exit(2)
}
if (!indexDir) {
  console.error('usage: node test/repo-recall.mjs --index-dir <dir> --mode off|balance|high [--out-dir reports]')
  process.exit(2)
}
const vectorMode = requestedMode === 'balance' ? 'fields' : requestedMode === 'high' ? 'readme' : 'off'
const weightLabel = requestedMode === 'off' ? '只用词面'
  : requestedMode === 'balance' ? ': 字段 = 1 : 0.35' : ': 字段 : README = 1 : 0.3 : 0.4'
const suite = JSON.parse(readFileSync(new URL('./repo-recall-20.queries.json', import.meta.url), 'utf8'))
const records = readRecords(resolve(indexDir))
if (!records) {
  console.error(`no usable index in ${resolve(indexDir)}`)
  process.exit(1)
}
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })

function matches(result, expected) {
  const target = result.install?.target ?? ''
  return result.name === expected
    || target === expected
    || target.startsWith(`${expected}@`)
}

const rows = []
for (const item of suite.positive) {
  const value = await search(searcher, {
    query: item.query,
    queryAlts: item.alts,
    limit: 10,
    preset: 'balanced',
    vectorMode,
    indexDir: resolve(indexDir),
    disposeClient: false,
  })
  const rank = value.results.findIndex(result => matches(result, item.expected))
  rows.push({
    query: item.query,
    expected: item.expected,
    rank: rank >= 0 ? rank + 1 : null,
    noMatch: value.noMatch,
    top3: value.results.slice(0, 3).map(result => result.name),
    vector: value.vector ?? null,
    gates: value.gates ?? null,
  })
}
disposeVectorRuntime()

const top3 = rows.filter(row => row.rank !== null && row.rank <= 3).length
const top10 = rows.filter(row => row.rank !== null).length
const json = {
  generatedAt: new Date().toISOString(),
  algorithm: ALGORITHM_VERSION,
  frozenAt: suite.frozenAt,
  indexDir: resolve(indexDir),
  current: records.name,
  mode: requestedMode,
  rows,
  summary: { top3, top10, total: rows.length },
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `repo-recall-20-${requestedMode}.json`), `${JSON.stringify(json, null, 2)}\n`)

const lines = [
  `# 20 仓库固定召回测试 · ${requestedMode} · ${ALGORITHM_VERSION}`,
  '',
  `- 索引：\`${records.name}\``,
  `- 算法：${ALGORITHM_VERSION}（BM25 ${weightLabel}）`,
  `- 模式：${requestedMode}`,
  `- 期望仓库进前 3：**${top3}/${rows.length}**`,
  `- 期望仓库进前 10：**${top10}/${rows.length}**`,
  '',
  '| # | 查询 | 期望仓库 | 排名 | 前 3 |',
  '|---:|---|---|---:|---|',
]
for (const [index, row] of rows.entries()) {
  lines.push(`| ${index + 1} | ${row.query.replace(/\|/g, '\\|')} | \`${row.expected}\` | ${row.rank ?? '>10'} | ${row.top3.join(' / ').replace(/\|/g, '\\|')} |`)
}
lines.push('')
if (requestedMode === 'high') {
  lines.push('## README 覆盖率')
  lines.push('')
  lines.push('| # | 查询 | covered | 字段 | README | 字段兜底 | GitHub | npm | circuit |')
  lines.push('|---:|---|---:|---:|---:|---:|---:|---:|---|')
  for (const [index, row] of rows.entries()) {
    const v = row.vector ?? {}
    lines.push(`| ${index + 1} | ${row.query.replace(/\|/g, '\\|')} | ${v.covered ?? ''} | ${v.fieldCovered ?? ''} | ${v.readmeCovered ?? ''} | ${v.readmeFallback ?? ''} | ${v.readmeSources?.github ?? ''} | ${v.readmeSources?.npm ?? ''} | ${v.circuit?.open ? 'open' : 'closed'} |`)
  }
  lines.push('')
}
writeFileSync(join(outDir, `repo-recall-20-${requestedMode}.md`), `${lines.join('\n')}\n`)

console.log(JSON.stringify({
  markdown: join(outDir, `repo-recall-20-${requestedMode}.md`),
  json: join(outDir, `repo-recall-20-${requestedMode}.json`),
  summary: json.summary,
  ranks: rows.map(row => ({ query: row.query, expected: row.expected, rank: row.rank })),
}, null, 2))
