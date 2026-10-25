#!/usr/bin/env node
/**
 * Count candidates and queries that clear the gate1 A/B lines at low, medium,
 * and high. Test-only diagnostic; reads the local index, writes nothing.
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
const CANDIDATE_POOL = 50

function recordContains(record, term) {
  const fields = [record.name, record.title, (record.topics ?? []).join(' '), (record.capability ?? []).join(' '), record.description]
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(term))
}

function applyNegation(allowed, terms) {
  if (terms.length === 0) return allowed
  const masked = Uint8Array.from(allowed)
  for (let index = 0; index < records.length; index += 1) {
    if (masked[index] === 0) continue
    if (terms.some(term => recordContains(records[index], term))) masked[index] = 0
  }
  return masked
}

function routeTermsOf(prepared, from) {
  if (from === 'query') return prepared.original.terms
  const index = Number(String(from).replace('alt', '')) - 1
  return prepared.rewrites[index]?.terms ?? prepared.original.terms
}

function candidatesFor(item) {
  const prepared = prepareQueries(item.query, item.alts)
  const routes = [prepared.original, ...prepared.rewrites].filter(route => route.terms.length > 0)
  const filter = selectFilter(records, { preset: 'balanced', minVerificationLevel: 4, runtimeVersion: detectRuntimeVersion() })
  const allowed = applyNegation(filter.allowed, prepared.not)
  const fused = new Map()
  routes.forEach((route, routeIndex) => {
    const weight = routeIndex === 0 ? 1 : 0.7
    const hits = searcher.bm25.search(route.terms, { allowed, limit: 400 })
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
    const key = record.repoKey || `name:${record.name.toLowerCase()}`
    if (groups.has(key)) continue
    groups.set(key, entry)
    if (groups.size >= CANDIDATE_POOL) break
  }
  return { prepared, candidates: [...groups.values()] }
}

const levels = [
  ['low', 0.45, 0.53],
  ['medium', 0.55, 0.65],
  ['high', 0.60, 0.70],
]
const positives = [
  ...JSON.parse(readFileSync('test/repo-recall-20.queries.json', 'utf8')).positive,
  ...JSON.parse(readFileSync('test/real-usage-v3.queries.json', 'utf8')).positive,
]
const negatives = JSON.parse(readFileSync('test/acceptance.queries.json', 'utf8')).negative
const suites = [['positive', positives], ['negative', negatives]]

const rows = []
for (const [label, items] of suites) {
  for (const [level, aLine, bLine] of levels) {
    let aPass = 0
    let bPass = 0
    let both = 0
    let any = 0
    let qA = 0
    let qB = 0
    let qAny = 0
    for (const item of items) {
      const { prepared, candidates } = candidatesFor(item)
      let queryA = false
      let queryB = false
      for (const entry of candidates) {
        const gate = evaluateGate1(records[entry.doc], routeTermsOf(prepared, entry.from), { strong: 0, hits: 0 })
        const passA = gate.strongField && gate.coverage >= aLine
        const passB = gate.hits >= 2 && gate.coverage >= bLine
        if (passA) aPass += 1
        if (passB) bPass += 1
        if (passA && passB) both += 1
        if (passA || passB) any += 1
        queryA ||= passA
        queryB ||= passB
      }
      if (queryA) qA += 1
      if (queryB) qB += 1
      if (queryA || queryB) qAny += 1
    }
    rows.push({ label, level, aLine, bLine, aPass, bPass, both, any, qA, qB, qAny, queries: items.length })
  }
}
console.log(JSON.stringify(rows, null, 2))
