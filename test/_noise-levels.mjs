#!/usr/bin/env node
/**
 * Count noMatch for every noiseFilter level on the positive and negative sets.
 * Test-only diagnostic; writes reports/noise-filter-levels.md.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, search } from '../lib/search.js'
import { detectRuntimeVersion } from '../lib/compat.js'
import { disposeVectorRuntime } from '../lib/vector.js'

const indexDir = resolve(process.env.LOCALAPPDATA + '\\dsh-plugin-discover')
const records = readRecords(indexDir)
const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })
const positives = [
  ...JSON.parse(readFileSync(new URL('./repo-recall-20.queries.json', import.meta.url), 'utf8')).positive,
  ...JSON.parse(readFileSync(new URL('./real-usage-v3.queries.json', import.meta.url), 'utf8')).positive,
]
const negatives = JSON.parse(readFileSync(new URL('./acceptance.queries.json', import.meta.url), 'utf8')).negative
const levels = ['none', 'low', 'medium', 'high']
const modes = [['off', 'off'], ['balance', 'fields'], ['high', 'readme']]
const rows = []
const positiveMisses = []

for (const level of levels) {
  for (const [mode, vectorMode] of modes) {
    let positiveNoMatch = 0
    let negativeNoMatch = 0
    for (const item of positives) {
      const value = await search(searcher, {
        query: item.query,
        queryAlts: item.alts,
        limit: 1,
        preset: 'balanced',
        vectorMode,
        noiseFilter: level,
        indexDir,
        disposeClient: false,
      })
      if (value.noMatch) {
        positiveNoMatch += 1
        positiveMisses.push({ level, mode, query: item.query, gates: value.gates })
      }
    }
    for (const item of negatives) {
      const value = await search(searcher, {
        query: item.query,
        queryAlts: item.alts,
        limit: 1,
        preset: 'balanced',
        vectorMode,
        noiseFilter: level,
        indexDir,
        disposeClient: false,
      })
      if (value.noMatch) negativeNoMatch += 1
    }
    rows.push({ level, mode, positiveNoMatch, negativeNoMatch })
    console.log(`${level}/${mode}: positive noMatch=${positiveNoMatch}/25 negative noMatch=${negativeNoMatch}/20`)
  }
}

const lines = [
  '# noiseFilter 四档 noMatch 统计',
  '',
  '- 日期：2026-10-24',
  '- 索引：`index-20261022T122813Z`',
  '- 正样本：仓库 20 + real-5 = 25；负样本：20 条域外',
  '- 只统计 `noMatch`，不统计排序',
  '',
  '| 档位 | 模式 | 正样本 noMatch | 负样本 noMatch |',
  '|---|---|---:|---:|',
]
for (const row of rows) lines.push(`| ${row.level} | ${row.mode} | ${row.positiveNoMatch}/25 | ${row.negativeNoMatch}/20 |`)
lines.push('', '## 正样本被误判 noMatch', '')
if (positiveMisses.length === 0) lines.push('无。')
else {
  lines.push('| 档位 | 模式 | 查询 | gate1 | gate2 |')
  lines.push('|---|---|---|---:|---:|')
  for (const item of positiveMisses) {
    lines.push(`| ${item.level} | ${item.mode} | ${item.query.replace(/\|/g, '\\|')} | ${item.gates?.gate1?.passed ?? '—'} | ${item.gates?.gate2?.passed ?? '—'} |`)
  }
}
lines.push('')
writeFileSync('reports/noise-filter-levels.md', `${lines.join('\n')}\n`, 'utf8')
disposeVectorRuntime()
