/**
 * In-memory BM25 over the current record set. Field weights are folded into a
 * weighted term frequency, so one postings list serves name (5), title (3),
 * topics (3), capability (3) and description (1).
 */
import { minHitsFor, tokenize } from './tokenize.js'

const K1 = 1.2
const B = 0.75
const FIELD_WEIGHTS = {
  name: 5,
  title: 3,
  topics: 3,
  capability: 3,
  description: 1,
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function editDistance(a, b, max) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  const previous = new Array(b.length + 1)
  const current = new Array(b.length + 1)
  for (let index = 0; index <= b.length; index += 1) previous[index] = index
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    let rowMin = current[0]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (current[j] < rowMin) rowMin = current[j]
    }
    if (rowMin > max) return max + 1
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }
  return previous[b.length]
}

function lowerBound(sorted, prefix) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] < prefix) low = middle + 1
    else high = middle
  }
  return low
}

/** A built BM25 index over one record array. */
export class Bm25Index {
  /** @param {object[]} records */
  constructor(records) {
    this.records = records
    this.postings = new Map()
    this.docLen = new Float64Array(records.length)
    this.vocab = []
    this.vocabByFirst = new Map()
    this.expansions = new Map()
    let total = 0
    for (let doc = 0; doc < records.length; doc += 1) {
      const record = records[doc]
      const weighted = new Map()
      const add = (text, weight) => {
        for (const term of tokenize(text)) weighted.set(term, (weighted.get(term) ?? 0) + weight)
      }
      add(record.name, FIELD_WEIGHTS.name)
      add(record.title, FIELD_WEIGHTS.title)
      add((record.topics ?? []).join(' '), FIELD_WEIGHTS.topics)
      add((record.capability ?? []).join(' '), FIELD_WEIGHTS.capability)
      add(record.description, FIELD_WEIGHTS.description)
      let length = 0
      for (const [term, tf] of weighted) {
        length += tf
        let posting = this.postings.get(term)
        if (!posting) {
          posting = { df: 0, docs: [] }
          this.postings.set(term, posting)
        }
        posting.df += 1
        posting.docs.push(doc, tf)
      }
      this.docLen[doc] = length
      total += length
    }
    this.avgdl = records.length > 0 ? total / records.length : 0
    this.vocab = [...this.postings.keys()].sort()
    for (const term of this.vocab) {
      const first = term[0]
      let bucket = this.vocabByFirst.get(first)
      if (!bucket) {
        bucket = []
        this.vocabByFirst.set(first, bucket)
      }
      bucket.push(term)
    }
  }

  /** Every spelling the index knows for one query term, with a weight. */
  expand(term) {
    const cached = this.expansions.get(term)
    if (cached) return cached
    const variants = [{ term, weight: 1 }]
    const seen = new Set([term])
    const isAscii = /^[a-z0-9]+$/.test(term)
    if (isAscii && term.length >= 2) {
      const start = lowerBound(this.vocab, term)
      let added = 0
      for (let index = start; index < this.vocab.length && added < 8; index += 1) {
        const candidate = this.vocab[index]
        if (!candidate.startsWith(term)) break
        if (seen.has(candidate)) continue
        seen.add(candidate)
        variants.push({ term: candidate, weight: 0.8 })
        added += 1
      }
    }
    if (isAscii && term.length >= 4) {
      const threshold = Math.min(2, Math.max(1, Math.round(term.length * 0.2)))
      const candidates = this.vocabByFirst.get(term[0]) ?? []
      let added = 0
      for (const candidate of candidates) {
        if (added >= 8) break
        if (seen.has(candidate) || Math.abs(candidate.length - term.length) > threshold) continue
        if (editDistance(term, candidate, threshold) <= threshold) {
          seen.add(candidate)
          variants.push({ term: candidate, weight: 0.6 })
          added += 1
        }
      }
    }
    this.expansions.set(term, variants)
    return variants
  }

  /**
   * Rank documents for one route.
   * @param {string[]} terms positive query terms
   * @param {{ allowed?: Uint8Array, limit?: number }} options
   */
  search(terms, { allowed = null, limit = 400 } = {}) {
    const count = this.records.length
    if (terms.length === 0 || count === 0) return []
    const scores = new Float64Array(count)
    const touched = []
    const seen = new Uint8Array(count)
    const matched = new Uint16Array(count)
    const lastTerm = new Int32Array(count).fill(-1)
    const minHits = minHitsFor(terms)
    const k1 = K1
    const b = B
    for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
      for (const variant of this.expand(terms[termIndex])) {
        const posting = this.postings.get(variant.term)
        if (!posting) continue
        const idf = Math.log(1 + (count - posting.df + 0.5) / (posting.df + 0.5))
        const docs = posting.docs
        for (let index = 0; index < docs.length; index += 2) {
          const doc = docs[index]
          if (allowed && allowed[doc] === 0) continue
          const tf = docs[index + 1]
          const length = this.docLen[doc]
          const norm = k1 * (1 - b + b * (this.avgdl > 0 ? length / this.avgdl : 0))
          const value = idf * (tf * (k1 + 1)) / (tf + norm) * variant.weight
          if (!seen[doc]) {
            seen[doc] = 1
            touched.push(doc)
          }
          scores[doc] += value
          if (lastTerm[doc] !== termIndex) {
            lastTerm[doc] = termIndex
            matched[doc] += 1
          }
        }
      }
    }
    const ranked = []
    for (const doc of touched) {
      if (matched[doc] < minHits) continue
      ranked.push({ doc, score: scores[doc], matched: matched[doc] })
    }
    ranked.sort((a, b2) => b2.score - a.score || a.doc - b2.doc)
    return ranked.slice(0, limit)
  }
}

/** Build a BM25 index for a record set. */
export function buildBm25(records) {
  return new Bm25Index(records)
}
