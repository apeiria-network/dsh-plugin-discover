#!/usr/bin/env node
/**
 * Real-usage acceptance sheet: five plugins the user actually uses. The
 * script records top-10 lexical results and the expected plugin's rank; the
 * "usable" judgment is deliberately left blank for the human.
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
const vectorMode = requestedMode === 'balance' ? 'fields' : requestedMode === 'high' ? 'readme' : 'off'
const weightLabel = requestedMode === 'off' ? 'off，只用词面'
  : requestedMode === 'balance' ? 'BM25 : 字段 = 1 : 0.35' : 'BM25 : 字段 : README = 1 : 0.3 : 0.4'
if (!['off', 'balance', 'high'].includes(requestedMode)) {
  console.error('usage: node test/real-usage.mjs --index-dir <dir> [--mode off|balance|high] [--queries file] [--out-dir reports]')
  process.exit(2)
}
if (!indexDir) {
  console.error('usage: node test/real-usage.mjs --index-dir <dir> [--mode off|balance|high] [--queries file] [--out-dir reports]')
  process.exit(2)
}
const suiteFile = valueOf('--queries') || './real-usage-v3.queries.json'
const suite = JSON.parse(readFileSync(new URL(suiteFile, import.meta.url), 'utf8'))
if (suite.deprecated) console.error(`warning: ${suiteFile} is deprecated; use ./real-usage-v3.queries.json`)
const records = readRecords(resolve(indexDir))
if (!records) {
  console.error(`no usable index in ${resolve(indexDir)}`)
  process.exit(1)
}
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })

function matches(result, expected) {
  const target = result.install?.target ?? result.target ?? ''
  const plainName = (result.name ?? '').replace(/^@/, '')
  return result.name === expected
    || plainName === expected
    || (result.title ?? '').toLowerCase() === expected.toLowerCase()
    || target === expected
    || target.startsWith(`${expected}@`)
    || target.startsWith(`${expected}#`)
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
    results: value.results.map(result => ({
      name: result.name,
      target: result.install?.target ?? '',
      title: result.title ?? null,
      stars: result.stars ?? null,
    })),
    vector: value.vector ?? null,
    gates: value.gates ?? null,
  })
}
disposeVectorRuntime()

const expectedTop3 = rows.filter(row => row.rank !== null && row.rank <= 3).length
const expectedTop10 = rows.filter(row => row.rank !== null).length
const stamp = suiteFile.includes('real-usage-v3') ? '2026-10-25-v3' : suiteFile.includes('real-usage-v2') ? '2026-10-24-v2' : '2026-10-23'
const suffix = requestedMode === 'off' ? '' : `-${requestedMode}`
const json = {
  generatedAt: new Date().toISOString(),
  algorithm: ALGORITHM_VERSION,
  indexDir: resolve(indexDir),
  current: records.name,
  mode: `vector ${requestedMode}, balanced, limit 10`,
  rows,
  summary: { expectedTop3, expectedTop10, total: rows.length },
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `real-usage-${stamp}${suffix}.json`), `${JSON.stringify(json, null, 2)}\n`)

const lines = [
  `# 真实使用插件验收（人工判分） · ${ALGORITHM_VERSION}`,
  '',
  `- 索引：\`${records.name}\``,
  `- 算法：${ALGORITHM_VERSION}（${weightLabel}）`,
  `- 模式：向量 \`${requestedMode}\`，balanced，limit 10`,
  `- 期望插件进前 3：**${expectedTop3}/${rows.length}**`,
  `- 期望插件进前 10：**${expectedTop10}/${rows.length}**`,
  '',
  '> 这不是自动通过/失败：请对每条判断“前 3 里有没有一个能用的插件”。',
  '> 期望插件没进前 3，不代表失败；如果前 3 有其他可用替代，也算可用。',
  '',
]
for (const [index, row] of rows.entries()) {
  lines.push(`## ${index + 1}. ${row.query}`)
  lines.push('')
  lines.push(`- 期望插件：\`${row.expected}\``)
  lines.push(`- 期望插件排名：${row.rank === null ? '**未进前 10**' : `**第 ${row.rank} 名**`}`)
  lines.push('- 人工判分：前 3 有可用？ [ ] 是 [ ] 否')
  lines.push('- 备注：')
  lines.push('')
  lines.push('| # | 插件 | 安装目标 |')
  lines.push('|---:|---|---|')
  for (const [rank, result] of row.results.entries()) {
    const mark = matches(result, row.expected) ? ' ← 期望' : ''
    lines.push(`| ${rank + 1} | ${result.name}${mark} | ${result.target.replace(/\|/g, '\\|')} |`)
  }
  lines.push('')
}
lines.push('## 汇总')
lines.push('')
lines.push('| # | 查询 | 期望插件排名 | 前 3 有可用？ |')
lines.push('|---:|---|---:|---|')
for (const [index, row] of rows.entries()) {
  lines.push(`| ${index + 1} | ${row.query.replace(/\|/g, '\\|')} | ${row.rank ?? '>10'} |  |`)
}
lines.push('')
writeFileSync(join(outDir, `real-usage-${stamp}${suffix}.md`), `${lines.join('\n')}\n`)

console.log(JSON.stringify({
  markdown: join(outDir, `real-usage-${stamp}${suffix}.md`),
  json: join(outDir, `real-usage-${stamp}${suffix}.json`),
  summary: json.summary,
  ranks: rows.map(row => ({ expected: row.expected, rank: row.rank })),
}, null, 2))
