#!/usr/bin/env node
/**
 * gate1 coverage distribution diagnostic. Reads the local index and prints
 * coverage for the strong path and the hits-only path. Test-only.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readRecords } from '../lib/store.js'
import { createSearcher, evaluateGate1 } from '../lib/search.js'
import { prepareQueries } from '../lib/tokenize.js'
import { selectFilter } from '../lib/filters.js'
import { detectRuntimeVersion } from '../lib/compat.js'

const indexDir = resolve(process.env.LOCALAPPDATA + '\\dsh-plugin-discover')
const records = readRecords(indexDir).records
const searcher = createSearcher(records, { runtimeVersion: detectRuntimeVersion() })
const RRF_K = 60
const ROUTE_WEIGHT = 1
const ALT_WEIGHT = 0.7
const CANDIDATE_POOL = 50

function recordContains(record, term) {
  const fields = [record.name, record.title, (record.topics ?? []).join(' '), (record.capability ?? []).join(' '), record.description]
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(term))
}

function applyNegation(records, allowed, terms) {
  if (terms.length === 0) return { allowed, dropped: 0 }
  const masked = Uint8Array.from(allowed)
  let dropped = 0
  for (let index = 0; index < records.length; index += 1) {
    if (masked[index] === 0) continue
    if (terms.some(term => recordContains(records[index], term))) {
      masked[index] = 0
      dropped += 1
    }
  }
  return { allowed: masked, dropped }
}

const groupKey = record => record.repoKey || `name:${record.name.toLowerCase()}`

function routeTermsOf(prepared, from) {
  if (from === 'query') return prepared.original.terms
  const index = Number(String(from).replace('alt', '')) - 1
  return prepared.rewrites[index]?.terms ?? prepared.original.terms
}

function candidatesFor(item) {
  const prepared = prepareQueries(item.query, item.alts)
  const routes = [prepared.original, ...prepared.rewrites].filter(route => route.terms.length > 0)
  const filter = selectFilter(records, { preset: 'balanced', minVerificationLevel: 4, runtimeVersion: detectRuntimeVersion() })
  const negation = applyNegation(records, filter.allowed, prepared.not)
  const fused = new Map()
  routes.forEach((route, routeIndex) => {
    const weight = routeIndex === 0 ? ROUTE_WEIGHT : ALT_WEIGHT
    const hits = searcher.bm25.search(route.terms, { allowed: negation.allowed, limit: 400 })
    hits.forEach((hit, rank) => {
      const contribution = weight / (RRF_K + rank + 1)
      const current = fused.get(hit.doc)
      if (!current) {
        fused.set(hit.doc, {
          doc: hit.doc,
          score: contribution,
          best: contribution,
          from: routeIndex === 0 ? 'query' : `alt${routeIndex}`,
        })
      } else {
        current.score += contribution
        if (contribution > current.best) {
          current.best = contribution
          current.from = routeIndex === 0 ? 'query' : `alt${routeIndex}`
        }
      }
    })
  })
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.doc - b.doc)
  const groups = new Map()
  for (const entry of ranked) {
    const record = records[entry.doc]
    const key = groupKey(record)
    if (groups.has(key)) continue
    groups.set(key, { ...entry })
    if (groups.size >= CANDIDATE_POOL) break
  }
  return { prepared, candidates: [...groups.values()].slice(0, CANDIDATE_POOL) }
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base] + (sorted[base + 1] !== undefined ? (sorted[base + 1] - sorted[base]) * rest : 0)
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return {
    n: sorted.length,
    min: sorted[0],
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.50),
    q3: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  }
}

const repo = JSON.parse(readFileSync('test/repo-recall-20.queries.json', 'utf8')).positive
const real = JSON.parse(readFileSync('test/real-usage-v3.queries.json', 'utf8')).positive
const negatives = JSON.parse(readFileSync('test/acceptance.queries.json', 'utf8')).negative
const positives = [...repo, ...real]
const groups = {
  positive: { strong: [], hitsOnly: [], neither: [] },
  negative: { strong: [], hitsOnly: [], neither: [] },
}
const thresholds = [0.33, 0.40, 0.50, 0.60, 0.70]
const counts = { strong: {}, hitsOnly: {} }
for (const t of thresholds) {
  counts.strong[t] = { positive: 0, negative: 0 }
  counts.hitsOnly[t] = { positive: 0, negative: 0 }
}

for (const [label, items] of [['positive', positives], ['negative', negatives]]) {
  for (const item of items) {
    const { prepared, candidates } = candidatesFor(item)
    for (const entry of candidates) {
      const gate = evaluateGate1(records[entry.doc], routeTermsOf(prepared, entry.from), { strong: 0, hits: 0 })
      const bucket = gate.strongField ? 'strong' : (gate.hits >= 2 ? 'hitsOnly' : 'neither')
      groups[label][bucket].push(gate.coverage)
      if (bucket === 'strong') {
        for (const t of thresholds) if (gate.coverage >= t) counts.strong[t][label] += 1
      }
      if (bucket === 'hitsOnly') {
        for (const t of thresholds) if (gate.coverage >= t) counts.hitsOnly[t][label] += 1
      }
    }
  }
}

const f = value => value === null ? '—' : value.toFixed(3)
console.log('| 数据 | 情况 | n | min | Q1 | median | Q3 | max |')
console.log('|---|---|---:|---:|---:|---:|---:|---:|')
for (const label of ['positive', 'negative']) {
  const data = groups[label]
  const name = label === 'positive' ? '正样本' : '负样本'
  for (const [bucket, bucketName] of [['strong', 'A strong'], ['hitsOnly', 'B hits-only'], ['neither', '两者都不满足']]) {
    const s = stats(data[bucket])
    console.log(`| ${name} | ${bucketName} | ${s?.n ?? 0} | ${f(s?.min)} | ${f(s?.q1)} | ${f(s?.median)} | ${f(s?.q3)} | ${f(s?.max)} |`)
  }
}
console.log('')
console.log('| coverage 阈值 | A strong 正 | A strong 负 | B hits-only 正 | B hits-only 负 |')
console.log('|---:|---:|---:|---:|---:|')
for (const t of thresholds) {
  console.log(`| ${t.toFixed(2)} | ${counts.strong[t].positive} | ${counts.strong[t].negative} | ${counts.hitsOnly[t].positive} | ${counts.hitsOnly[t].negative} |`)
}
