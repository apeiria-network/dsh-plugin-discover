/**
 * The local retrieval pipeline: normalize, hard-filter, four-way BM25, RRF,
 * repo merge, (optional) vector rerank, quality prior, and a bounded result.
 */
import { buildBm25 } from './bm25.js'
import { qualityFactor } from './quality.js'
import { selectFilter } from './filters.js'
import { prepareQueries, tokenize } from './tokenize.js'
import { vectorRerank } from './vector.js'
import { fetchReadmeText } from './readme-source.js'

const RRF_K = 60
const ROUTE_WEIGHT = 1
const ALT_WEIGHT = 0.7
const CANDIDATE_POOL = 50

/** v2.4 gate1: exact-evidence check used only to decide whether a query has a match. */
export const GATE1_MIN_STRONG_COVERAGE = 0.55
export const GATE1_MIN_HITS_COVERAGE = 0.65
export const GATE1_MAX_HITS = 8
export const GATE1_MAX_DENOMINATOR = 8

/** User-facing irrelevant-result filter strength. */
export const NOISE_FILTER_LEVELS = Object.freeze({
  none: Object.freeze({ gate1: null, gate2: null }),
  low: Object.freeze({
    gate1: Object.freeze({ strong: 0.45, hits: 0.53 }),
    gate2: 0.815,
  }),
  medium: Object.freeze({
    gate1: Object.freeze({ strong: GATE1_MIN_STRONG_COVERAGE, hits: GATE1_MIN_HITS_COVERAGE }),
    gate2: 0.85,
  }),
  high: Object.freeze({
    gate1: Object.freeze({ strong: 0.60, hits: 0.70 }),
    gate2: 0.87,
  }),
})
export const DEFAULT_NOISE_FILTER = 'medium'
export const NOISE_FILTERS = Object.freeze(Object.keys(NOISE_FILTER_LEVELS))

export function noiseFilterConfig(level) {
  return NOISE_FILTER_LEVELS[level] ?? NOISE_FILTER_LEVELS[DEFAULT_NOISE_FILTER]
}

/** Build the per-index search state once and reuse it for every query. */
export function createSearcher(records, { runtimeVersion = null } = {}) {
  const byKey = new Map()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    byKey.set(record.id, index)
    byKey.set(record.name, index)
    if (record.alias) byKey.set(record.alias, index)
    if (record.install?.target) byKey.set(record.install.target, index)
  }
  // Merged-away ids and names stay reachable through aliases/copies, but never
  // shadow a canonical card's own keys.
  const remember = (key, index) => {
    if (typeof key === 'string' && key !== '' && !byKey.has(key)) byKey.set(key, index)
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    for (const alias of record.aliases ?? []) remember(alias, index)
    for (const copy of record.copies ?? []) {
      remember(copy.id, index)
      remember(copy.name, index)
      remember(copy.target, index)
    }
  }
  return {
    records,
    bm25: buildBm25(records),
    byKey,
    runtimeVersion,
  }
}

function groupKey(record) {
  return record.repoKey || `name:${record.name.toLowerCase()}`
}

function recordContains(record, term) {
  const fields = [
    record.name,
    record.title,
    (record.topics ?? []).join(' '),
    (record.capability ?? []).join(' '),
    record.description,
  ]
  return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(term))
}

/** Zero out allowed documents that contain a negated term. */
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

function routeTermsOf(prepared, from) {
  if (from === 'query') return prepared.original.terms
  const index = Number(String(from).replace('alt', '')) - 1
  return prepared.rewrites[index]?.terms ?? prepared.original.terms
}

function evidenceFor(record, terms, maxHits = 6) {
  const fields = []
  const text = {
    name: record.name,
    title: record.title ?? '',
    topics: (record.topics ?? []).join(' '),
    capability: (record.capability ?? []).join(' '),
    description: record.description ?? '',
  }
  const hits = []
  for (const term of terms) {
    let matched = false
    for (const [field, value] of Object.entries(text)) {
      if (typeof value !== 'string' || value === '') continue
      if (value.toLowerCase().includes(term)) {
        if (!fields.includes(field)) fields.push(field)
        matched = true
      }
    }
    if (matched) hits.push(term)
    if (hits.length >= maxHits) break
  }
  return { fields, terms: hits }
}

/**
 * gate1 evidence check. It is a judgment, not a filter: the caller uses
 * `pass` only to decide whether the query has any matching candidate. It does
 * not reorder or delete individual candidates.
 */
export function evaluateGate1(record, terms, thresholds = NOISE_FILTER_LEVELS.medium.gate1) {
  const evidence = evidenceFor(record, terms, GATE1_MAX_HITS)
  const denominator = Math.max(1, Math.min(terms.length, GATE1_MAX_DENOMINATOR))
  const coverage = evidence.terms.length / denominator
  const strongField = evidence.fields.some(field => field === 'name' || field === 'topics' || field === 'capability')
  const pass = (strongField && coverage >= thresholds.strong)
    || (evidence.terms.length >= 2 && coverage >= thresholds.hits)
  return {
    pass,
    hits: evidence.terms.length,
    terms: terms.length,
    denominator,
    coverage,
    strongField,
    fields: evidence.fields,
  }
}

function badgesFor(record) {
  const badges = {}
  if (record.verification?.level) badges.verification = `L${record.verification.level}`
  if (record.security?.status === 'audited' && record.security.riskLevel) {
    badges.security = record.security.riskLevel
  } else if (record.security?.status) {
    badges.security = record.security.status
  }
  if (record.updatedAt) badges.updatedAt = record.updatedAt.slice(0, 10)
  return badges
}

function resultFor(record, { from, terms, extraAlternatives = [], evidence = null }) {
  const result = {
    id: record.id,
    name: record.name,
    description: record.description,
    evidence: { ...(evidence ?? evidenceFor(record, terms)), from },
    alternatives: [
      ...new Set([
        ...(record.alternatives ?? []).map(item => item.name),
        ...extraAlternatives,
      ]),
    ].filter(name => name && name !== record.name).slice(0, 6),
  }
  if (typeof record.stars === 'number') result.stars = record.stars
  if (record.title) result.title = record.title
  if (record.install?.target) result.install = { target: record.install.target }
  const badges = badgesFor(record)
  if (Object.keys(badges).length > 0) result.badges = badges
  return result
}

/**
 * Run one search.
 * @param {ReturnType<typeof createSearcher>} searcher
 * @param {object} params
 */
export async function search(searcher, {
  query,
  queryAlts = [],
  limit = 10,
  preset = 'balanced',
  minVerificationLevel = 4,
  vectorMode = 'off',
  vectorTopN = CANDIDATE_POOL,
  noiseFilter = DEFAULT_NOISE_FILTER,
  readmeOptions = null,
  indexDir = null,
  disposeClient = true,
  coverage = null,
} = {}) {
  const prepared = prepareQueries(query, queryAlts)
  const routes = [prepared.original, ...prepared.rewrites].filter(route => route.terms.length > 0)
  const selectedNoise = NOISE_FILTERS.includes(noiseFilter) ? noiseFilter : DEFAULT_NOISE_FILTER
  const noise = noiseFilterConfig(selectedNoise)
  const interpreted = {
    terms: prepared.original.terms,
    not: prepared.not,
    filters: { preset },
  }
  const empty = {
    query,
    interpreted,
    filterStats: { droppedBy: { security: 0, compat: 0, verification: 0, negation: 0 } },
    results: [],
    noMatch: true,
    ...(coverage ? { coverage } : {}),
  }
  if (routes.length === 0) return empty

  const filter = selectFilter(searcher.records, {
    preset,
    minVerificationLevel,
    runtimeVersion: searcher.runtimeVersion,
  })
  interpreted.filters.preset = filter.preset
  if (filter.relaxedFrom) interpreted.filters.relaxedFrom = filter.relaxedFrom

  const negation = applyNegation(searcher.records, filter.allowed, prepared.not)

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
          matched: hit.matched,
        })
      } else {
        current.score += contribution
        if (contribution > current.best) {
          current.best = contribution
          current.from = routeIndex === 0 ? 'query' : `alt${routeIndex}`
        }
        current.matched = Math.max(current.matched, hit.matched)
      }
    })
  })

  const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.doc - b.doc)
  const candidatePool = vectorMode === 'off'
    ? CANDIDATE_POOL
    : Math.min(200, Math.max(2, Math.round(Number(vectorTopN) || CANDIDATE_POOL)))
  const groups = new Map()
  for (const entry of ranked) {
    const record = searcher.records[entry.doc]
    const key = groupKey(record)
    const group = groups.get(key)
    if (group) {
      group.extras.push(record.name)
      continue
    }
    groups.set(key, { ...entry, extras: [] })
    if (groups.size >= candidatePool) break
  }
  let candidates = [...groups.values()].slice(0, candidatePool)
  const gate1Total = candidates.length
  const gate1Enabled = Boolean(noise.gate1)
  if (gate1Enabled) {
    for (const entry of candidates) {
      const record = searcher.records[entry.doc]
      entry.gate1 = evaluateGate1(record, routeTermsOf(prepared, entry.from), noise.gate1)
    }
  }
  const gate1PassCount = gate1Enabled
    ? candidates.filter(entry => entry.gate1.pass).length
    : gate1Total
  const gate1Any = gate1Enabled ? gate1PassCount > 0 : true
  const filterStats = {
    droppedBy: {
      security: filter.droppedBy.security,
      compat: filter.droppedBy.compatibility,
      verification: filter.droppedBy.verification,
      negation: negation.dropped,
    },
  }
  const gatesFor = gate2 => ({
    level: selectedNoise,
    gate1: {
      enabled: gate1Enabled,
      passed: gate1Any,
      passCount: gate1PassCount,
      total: gate1Total,
    },
    ...(gate2 ? { gate2 } : {}),
  })
  const noMatchValue = gates => ({
    query,
    interpreted,
    filterStats,
    results: [],
    noMatch: true,
    ...(coverage ? { coverage } : {}),
    gates,
  })

  // gate1 is a judgment, not a per-candidate filter or reorder. In lexical
  // mode a query with no gate1-passing candidate is a genuine noMatch; a
  // passing candidate keeps the normal BM25 order (including gate1 failures).
  if (gate1Enabled && vectorMode === 'off' && !gate1Any) return noMatchValue(gatesFor())

  const vector = await vectorRerank(candidates, routes, {
    mode: vectorMode,
    gate2Threshold: noise.gate2,
    indexDir,
    records: searcher.records,
    disposeClient,
    readmeOptions,
  })
  if (vector?.candidates) candidates = vector.candidates

  // gate2 is also a judgment. Balance/high only become noMatch when neither
  // gate1 nor gate2 has a passing candidate; otherwise the normal vector order
  // is returned, including candidates that fail one or both gates.
  let gate2 = null
  if (vectorMode !== 'off') {
    if (!noise.gate2) {
      gate2 = { enabled: false, passed: true, available: Boolean(vector) }
    } else if (vector?.gate2) {
      gate2 = { ...vector.gate2, enabled: true, available: true }
    } else {
      gate2 = { enabled: true, available: false, passed: false, threshold: noise.gate2 }
    }
  }
  if (gate1Enabled && vectorMode !== 'off' && !gate1Any && gate2 && !gate2.passed) {
    return noMatchValue(gatesFor(gate2))
  }
  const gates = gatesFor(gate2)

  // Evidence is kept for diagnostics/reporting; it never drops a candidate.
  const rankedWithEvidence = candidates.map(entry => {
    const record = searcher.records[entry.doc]
    const terms = routeTermsOf(prepared, entry.from)
    const evidenceTerms = [...new Set([...terms, ...prepared.original.terms])]
    const evidence = evidenceTerms.length === terms.length
      ? evidenceFor(record, terms)
      : evidenceFor(record, evidenceTerms)
    return { ...entry, evidence, terms: evidenceTerms }
  })

  const results = rankedWithEvidence
    .map(entry => {
      const record = searcher.records[entry.doc]
      return {
        entry,
        record,
        finalScore: entry.score * qualityFactor(record),
      }
    })
    .sort((a, b) => b.finalScore - a.finalScore || a.entry.doc - b.entry.doc)
    .slice(0, Math.min(20, Math.max(1, limit)))
    .map(({ entry, record }) => resultFor(record, {
      from: entry.from,
      terms: entry.terms,
      extraAlternatives: entry.extras,
      evidence: entry.evidence,
    }))

  const value = {
    query,
    interpreted,
    filterStats,
    results,
    noMatch: results.length === 0,
    gates,
    ...(coverage ? { coverage } : {}),
  }
  if (vector) {
    value.vector = {
      mode: vector.mode,
      ...(vector.algorithm ? { algorithm: vector.algorithm } : {}),
      covered: vector.covered,
      ...(vector.fieldCovered !== undefined ? { fieldCovered: vector.fieldCovered } : {}),
      ...(vector.degraded ? { degraded: vector.degraded } : {}),
      ...(vector.error ? { error: vector.error } : {}),
      ...(vector.readmeCovered !== undefined ? { readmeCovered: vector.readmeCovered } : {}),
      ...(vector.readmeFallback !== undefined ? { readmeFallback: vector.readmeFallback } : {}),
      ...(vector.readmeSources ? { readmeSources: vector.readmeSources } : {}),
      ...(vector.circuit ? { circuit: vector.circuit } : {}),
      ...(vector.notice ? { notice: vector.notice } : {}),
    }
  }
  return value
}

/** Look up one record without searching. */
export function explain(searcher, id, { query = '', coverage = null } = {}) {
  const index = searcher.byKey.get(id)
  const value = {
    query,
    noMatch: index === undefined,
    results: [],
    ...(coverage ? { coverage } : {}),
  }
  if (index === undefined) {
    value.explain = { found: false, id }
    return value
  }
  const record = searcher.records[index]
  value.explain = {
    found: true,
    id: record.id,
    name: record.name,
    alias: record.alias,
    title: record.title,
    description: record.description,
    topics: record.topics,
    capability: record.capability,
    stars: record.stars,
    verification: record.verification,
    security: record.security,
    repo: record.repo,
    url: record.url,
    install: record.install,
    dshRange: record.dshRange,
    updatedAt: record.updatedAt,
    kind: record.kind,
    sources: record.sources,
    alternatives: record.alternatives ?? [],
    copies: record.copies ?? [],
  }
  return value
}

/**
 * `explain` plus an optional README fetch. Kept separate so the synchronous
 * lookup stays usable without network access; `readme: true` adds a sibling
 * `readme` field and never changes the `explain` payload.
 */
export async function explainWithReadme(searcher, id, {
  query = '',
  coverage = null,
  readme = false,
  readmeMaxChars,
  readmeOptions = null,
  fetchImpl,
  limiter = null,
} = {}) {
  const value = explain(searcher, id, { query, ...(coverage ? { coverage } : {}) })
  if (!readme || !value.explain?.found) return value
  const record = searcher.records[searcher.byKey.get(id)]
  const maxChars = Number(readmeMaxChars)
  try {
    value.readme = await fetchReadmeText(record, {
      ...(fetchImpl ? { fetchImpl } : {}),
      limiter,
      ...(Number.isFinite(maxChars) && maxChars > 0 ? { maxChars } : {}),
      ...(readmeOptions?.requestTimeoutMs ? { timeoutMs: readmeOptions.requestTimeoutMs } : {}),
    })
  } catch (error) {
    value.readme = {
      available: false,
      reason: 'error',
      notice: error instanceof Error ? error.message : String(error),
    }
  }
  return value
}

/** Diagnostics helper: the token list a document contributes, for tests. */
export function documentTokens(record) {
  return [
    ...tokenize(record.name),
    ...tokenize(record.title),
    ...tokenize((record.topics ?? []).join(' ')),
    ...tokenize((record.capability ?? []).join(' ')),
    ...tokenize(record.description),
  ]
}
