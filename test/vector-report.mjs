#!/usr/bin/env node
/**
 * Produce the persisted vector-integration report: per-query lexical and
 * vector top-10 rankings, negative results, readme fallback counts, and
 * latency. Writes a Markdown report plus a raw JSON file.
 *
 *   node test/vector-report.mjs --index-dir <dir> [--out-dir reports]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, search } from '../lib/search.js'
import { disposeVectorRuntime } from '../lib/vector.js'
import { detectRuntimeVersion } from '../lib/compat.js'

const args = process.argv.slice(2)
const valueOf = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const indexDir = resolve(valueOf('--index-dir') || process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR || '')
const outDir = resolve(valueOf('--out-dir') || 'reports')
if (!valueOf('--index-dir') && !process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR) {
  console.error('usage: node test/vector-report.mjs --index-dir <dir> [--out-dir reports]')
  process.exit(2)
}
const suite = JSON.parse(readFileSync(new URL('./acceptance.queries.json', import.meta.url), 'utf8'))
const records = readRecords(indexDir)
if (!records) {
  console.error(`no usable index in ${indexDir}`)
  process.exit(1)
}
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })
const base = { limit: 10, indexDir, disposeClient: false }

function compact(result) {
  return {
    id: result.id,
    name: result.name,
    stars: result.stars ?? null,
    badges: result.badges ?? null,
    install: result.install ?? null,
    description: result.description ?? '',
  }
}

async function run(item, vectorMode) {
  const started = Date.now()
  const value = await search(searcher, {
    ...base,
    query: item.query,
    queryAlts: item.alts,
    vectorMode,
  })
  return {
    mode: vectorMode,
    ms: Date.now() - started,
    noMatch: value.noMatch,
    interpreted: value.interpreted,
    filterStats: value.filterStats,
    vector: value.vector ?? null,
    results: value.results.map(compact),
  }
}

const positive = suite.positive.map(item => ({ query: item.query, alts: item.alts }))
for (const item of positive) item.lexical = await run(item, 'off')
for (const item of positive) item.fields = await run(item, 'fields')
for (const item of positive) item.readme = await run(item, 'readme')

const negative = suite.negative.map(item => ({ query: item.query, alts: item.alts }))
for (const item of negative) item.lexical = await run(item, 'off')
for (const item of negative) item.fields = await run(item, 'fields')

disposeVectorRuntime()

const stamp = '2026-10-22'
const json = {
  format: 1,
  generatedAt: new Date().toISOString(),
  indexDir,
  current: records.name,
  runtimeVersion: detectRuntimeVersion(),
  positive,
  negative,
}
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `vector-ranks-${stamp}.json`), `${JSON.stringify(json, null, 2)}\n`)

const nameList = results => results.length === 0 ? '(noMatch)' : results.map(result => result.name).join(' → ')
const cell = name => String(name ?? '').replace(/\|/g, '\\|')
const top = (run, count = 10) => run.results.slice(0, count)

const lines = []
lines.push('# 向量接入测试与逐条排名')
lines.push('')
lines.push(`- 日期：${stamp}`)
lines.push(`- 索引：\`${records.name}\`（${indexDir}）`)
lines.push(`- DSH：${detectRuntimeVersion() ?? '未检测到'}`)
lines.push('- 模型：`dsh-plugin-discover-model@0.1.0`（multilingual-e5-small int8 ONNX，384 维）')
lines.push('- 线程：ONNX 固定 4 线程（`DSH_MODEL_THREADS` 可调），不占满 16 个逻辑核')
lines.push('- 模式：词面 `off` vs 向量 `fields`；另有 `readme` 兜底统计')
lines.push('')
lines.push('> 自动指标：词面 20/20 非空、4/5 noMatch；单测 45/45；表格为逐条 top-10。')
lines.push('')
lines.push('## 1. 正样本逐条排名')
lines.push('')
for (const [index, item] of positive.entries()) {
  const lexical = item.lexical
  const fields = item.fields
  const changed = JSON.stringify(top(lexical, 3).map(result => result.name))
    !== JSON.stringify(top(fields, 3).map(result => result.name))
  lines.push(`### ${index + 1}. ${item.query}`)
  lines.push('')
  lines.push(`词面：${lexical.ms} ms · ${lexical.noMatch ? 'noMatch' : `${lexical.results.length} 条`} · 向量：${fields.ms} ms · ${fields.noMatch ? 'noMatch' : `${fields.results.length} 条`}${changed ? ' · **top-3 变化**' : ''}`)
  lines.push('')
  lines.push('| # | 词面 off | 向量 fields |')
  lines.push('|---:|---|---|')
  for (let rank = 0; rank < 10; rank += 1) {
    const left = lexical.results[rank]
    const right = fields.results[rank]
    if (!left && !right) break
    lines.push(`| ${rank + 1} | ${cell(left?.name ?? '')} | ${cell(right?.name ?? '')} |`)
  }
  if (fields.vector) lines.push('')
  if (fields.vector) lines.push(`\`fields\` 向量：${JSON.stringify(fields.vector)}`)
  lines.push('')
}

lines.push('## 2. 负样本')
lines.push('')
lines.push('| # | 查询 | 词面 | 向量 fields |')
lines.push('|---:|---|---|---|')
for (const [index, item] of negative.entries()) {
  const lexical = item.lexical.noMatch ? 'noMatch' : nameList(item.lexical.results.slice(0, 3))
  const fields = item.fields.noMatch ? 'noMatch' : nameList(item.fields.results.slice(0, 3))
  lines.push(`| ${index + 1} | ${cell(item.query)} | ${cell(lexical)} | ${cell(fields)} |`)
}
lines.push('')

lines.push('## 3. readme 模式兜底')
lines.push('')
lines.push('| # | 查询 | covered | readmeCovered | readmeFallback | 耗时 |')
lines.push('|---:|---|---:|---:|---:|---:|')
for (const [index, item] of positive.entries()) {
  const readme = item.readme
  const vector = readme.vector ?? {}
  lines.push(`| ${index + 1} | ${cell(item.query)} | ${vector.covered ?? 0} | ${vector.readmeCovered ?? 0} | ${vector.readmeFallback ?? 0} | ${readme.ms} ms |`)
}
lines.push('')
lines.push('> 本机 `raw.githubusercontent.com` 不可达；readme 结果全部回退字段向量。`readmeCovered` 是真正用上 README 向量的条数。')
lines.push('')

lines.push('## 4. 性能')
lines.push('')
const allTimes = mode => positive.flatMap(item => [item.lexical, item.fields, item.readme]).filter(run => run.mode === mode).map(run => run.ms)
for (const mode of ['off', 'fields', 'readme']) {
  const times = allTimes(mode).sort((a, b) => a - b)
  if (times.length === 0) continue
  const median = times[Math.floor(times.length / 2)]
  lines.push(`- \`${mode}\`：最小 ${times[0]} ms · 中位 ${median} ms · 最大 ${times[times.length - 1]} ms`)
}
lines.push('')
lines.push('`fields` 首条包含模型子进程启动与 50 条嵌入；ONNX 固定 4 线程，后续通常在 1.5–2.3 秒（更长文本批次约 3 秒）。默认不再按文档数回收子进程；`DSH_MODEL_RECYCLE_DOCS` 是异常环境下的可选逃生开关。')
lines.push('')

lines.push('## 5. 已知限制')
lines.push('')
lines.push('- `fields` 模式下，OCR 首条从 `dsh-ocr-local` 变为 Mac 专用的 `locallens`；`dsh-ocr-local` 仍在前 3。')
lines.push('- `readme` 的真实网络路径在本机未验证；只验证了失败回退。')
lines.push('- 模型包通过 tarball 安装，`onnxruntime-node` 的 postinstall 被 pnpm 跳过；预编译二进制可用。')
lines.push('- 早期让 ONNX 使用默认 16 线程时会把 CPU 打满，随后在 CPU 配额/降频下线程池自旋，50 条退化到 12–15 秒；现在固定 4 线程，10 轮连续测试保持 2.2–3.1 秒。')
lines.push('- 这只是逐条排名与自动门槛，不是正式 20 条人工命中率判分。')
lines.push('')

writeFileSync(join(outDir, `vector-ranks-${stamp}.md`), `${lines.join('\n')}\n`)

const positiveNonEmpty = positive.filter(item => !item.fields.noMatch).length
const negativeNoMatch = negative.filter(item => item.fields.noMatch).length
console.log(JSON.stringify({
  markdown: join(outDir, `vector-ranks-${stamp}.md`),
  json: join(outDir, `vector-ranks-${stamp}.json`),
  positiveNonEmpty,
  negativeNoMatch,
  fieldsCovered: positive.map(item => item.fields.vector?.covered ?? 0),
  readme: positive.map(item => item.readme.vector ?? null),
}, null, 2))
