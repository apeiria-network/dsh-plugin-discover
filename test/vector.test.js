import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { record } from './fixtures.js'
import { vectorRerank, weightedRrf, ALGORITHM_VERSION, RRF_WEIGHTS } from '../lib/vector.js'
import { githubGuard } from '../lib/readme-source.js'
import { decodeVector, encodeVector } from '../lib/vector-store.js'
import { ModelUnavailableError } from '../lib/model-client.js'

function vectorFor(text) {
  const value = String(text).toLowerCase()
  if (value.includes('sidebar') || value.includes('ui')) return Float32Array.from([1, 0])
  if (value.includes('git') || value.includes('review')) return Float32Array.from([0, 1])
  return Float32Array.from([0.5, 0.5])
}

function fakeClient(counters) {
  return {
    async embed(texts, kind) {
      counters[kind] = (counters[kind] ?? 0) + texts.length
      return texts.map(vectorFor)
    },
    async truncate(text, limit) {
      counters.truncate += 1
      return { text: String(text).slice(0, limit), tokens: Math.min(limit, String(text).length) }
    },
    dispose() {
      counters.dispose += 1
    },
  }
}

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-vector-'))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('fp16 vectors round-trip within tolerance', () => {
  const vector = Float32Array.from({ length: 384 }, (_, index) => Math.sin(index / 7))
  const decoded = decodeVector(encodeVector(vector))
  assert.equal(decoded.length, 384)
  for (let index = 0; index < vector.length; index += 1) {
    assert.ok(Math.abs(decoded[index] - vector[index]) < 0.002)
  }
})

test('weights are mode-specific: fields 1 : 0.35, readme 1 : 0.3 : 0.4', () => withDir(async dir => {
  assert.equal(ALGORITHM_VERSION, 'v1.1')
  assert.equal(weightedRrf({ bm25: 1, fields: 1 }, RRF_WEIGHTS.fields), 1 / 61 + 0.35 / 61)
  assert.equal(weightedRrf({ bm25: 1, fields: 2, readme: 3 }, RRF_WEIGHTS.readme), 1 / 61 + 0.3 / 62 + 0.4 / 63)
  // a missing list contributes nothing; readme weight is zero in fields mode
  assert.equal(weightedRrf({ bm25: 1, fields: 2 }, RRF_WEIGHTS.fields), 1 / 61 + 0.35 / 62)
  assert.equal(weightedRrf({ bm25: 1, fields: 1, readme: 1 }, RRF_WEIGHTS.fields), 1 / 61 + 0.35 / 61)

  const records = [
    record({ id: 'a', name: 'a', description: 'A git review tool.', repo: 'https://github.com/acme/a' }),
    record({ id: 'b', name: 'b', description: 'A sidebar UI tool.', repo: 'https://github.com/acme/b' }),
  ]
  const candidates = [
    { doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] },
    { doc: 1, score: 0.01, from: 'alt1', matched: 1, extras: [] },
  ]
  const routes = [{ text: 'sidebar ui', terms: ['sidebar', 'ui'] }]
  const result = await vectorRerank(candidates, routes, {
    mode: 'fields',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient({ query: 0, passage: 0, truncate: 0, dispose: 0 }),
  })
  assert.equal(result.algorithm, 'v1.1')
  assert.equal(result.covered, 2)
  // b is the vector favourite; with fields weight 0.35 the BM25 leader a still wins
  assert.equal(result.candidates[0].doc, 0)
  assert.ok(result.candidates[1].vectorSimilarity > result.candidates[0].vectorSimilarity)
}))

test('fields mode computes vectors, preserves BM25 on an exact rank swap, and caches', () => withDir(async dir => {
  const records = [
    record({ id: 'a', name: 'a', description: 'A git review tool.', repo: 'https://github.com/acme/a' }),
    record({ id: 'b', name: 'b', description: 'A sidebar UI tool.', repo: 'https://github.com/acme/b' }),
  ]
  const candidates = [
    { doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] },
    { doc: 1, score: 0.01, from: 'alt1', matched: 1, extras: [] },
  ]
  const routes = [
    { text: 'sidebar ui', terms: ['sidebar', 'ui'] },
    { text: 'sidebar', terms: ['sidebar'] },
  ]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const first = await vectorRerank(candidates, routes, {
    mode: 'fields',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
  })
  assert.equal(first.mode, 'fields')
  assert.equal(first.algorithm, 'v1.1')
  assert.equal(first.covered, 2)
  assert.equal(first.fieldCovered, 2)
  assert.equal(first.gate2.passed, true)
  assert.ok(first.gate2.maxSimilarity > 0.3)
  // b is the better vector match but a is the better BM25 match; the fields
  // weight 0.35 keeps a ahead.
  assert.equal(first.candidates[0].doc, 0)
  assert.ok(first.candidates[1].vectorSimilarity > first.candidates[0].vectorSimilarity)
  const firstPassages = counters.passage
  assert.equal(firstPassages, 2)

  const second = await vectorRerank(candidates, routes, {
    mode: 'fields',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
  })
  assert.equal(second.covered, 2)
  assert.equal(counters.passage, firstPassages, 'field vectors should come from cache')
}))

test('gate2 fails when the best query-vector similarity is at most 0.3', () => withDir(async dir => {
  const records = [
    record({ id: 'a', name: 'a', description: 'A git review tool.', repo: 'https://github.com/acme/a' }),
  ]
  const candidates = [{ doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] }]
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const result = await vectorRerank(candidates, routes, {
    mode: 'fields',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient({ query: 0, passage: 0, truncate: 0, dispose: 0 }),
  })
  assert.equal(result.covered, 1)
  assert.equal(result.gate2.passed, false)
  assert.equal(result.gate2.maxSimilarity, 0)
}))

test('readme mode caches excerpts and vectors, then falls back to fields', () => withDir(async dir => {
  githubGuard.reset()
  const records = [
    record({ id: 'a', name: 'a', description: 'A git review tool.', repo: 'https://github.com/acme/a' }),
    record({ id: 'b', name: 'b', description: 'A sidebar UI tool.', repo: '' }),
  ]
  const candidates = [
    { doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] },
    { doc: 1, score: 0.01, from: 'query', matched: 1, extras: [] },
  ]
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  let fetches = 0
  let rawFetches = 0
  const fetchImpl = async uri => {
    fetches += 1
    if (uri.includes('registry.npmjs.org')) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    }
    if (!uri.includes('raw.githubusercontent.com')) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' }
    }
    rawFetches += 1
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'etag-1' },
      text: async () => 'A sidebar UI plugin with a long README. ' + 'x'.repeat(500),
    }
  }
  const options = {
    mode: 'readme',
    indexDir: dir,
    records,
    routes,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    readmeBudgetMs: 10000,
  }
  const first = await vectorRerank(candidates, routes, options)
  assert.equal(first.mode, 'readme')
  assert.equal(first.algorithm, 'v1.1')
  assert.equal(first.covered, 2)
  assert.equal(first.fieldCovered, 2)
  assert.equal(first.readmeCovered, 1)
  assert.equal(first.readmeFallback, 1)
  assert.ok(fetches >= 1)
  const firstPassages = counters.passage

  const second = await vectorRerank(candidates, routes, options)
  assert.equal(second.covered, 2)
  assert.equal(counters.passage, firstPassages, 'README and field vectors should come from cache')
  assert.equal(rawFetches, 1, 'fresh excerpt should not be fetched twice')
  assert.ok(counters.truncate >= 1)
  githubGuard.reset()
}))

test('retries a flaky model with a fresh client, then degrades with a notice', () => withDir(async dir => {
  const records = [record({ id: 'a', name: 'alpha' }), record({ id: 'b', name: 'beta' })]
  const candidates = [
    { doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] },
    { doc: 1, score: 0.01, from: 'query', matched: 1, extras: [] },
  ]
  const routes = [{ text: 'alpha helper', terms: ['alpha', 'helper'], not: [] }]
  let factoryCalls = 0
  const flaky = () => {
    factoryCalls += 1
    if (factoryCalls <= 2) {
      return { embed: async () => { throw new ModelUnavailableError('spawn EPERM') }, truncate: async text => ({ text }), dispose: () => {} }
    }
    return fakeClient({ passage: 0, query: 0, truncate: 0 })
  }
  const recovered = await vectorRerank(candidates, routes, {
    mode: 'fields', indexDir: dir, records, routes, serverPath: 'fake-server', clientFactory: flaky,
  })
  assert.equal(recovered.mode, 'fields')
  assert.equal(recovered.degraded, undefined, 'should recover inside one call')
  assert.equal(recovered.covered, 2)
  assert.equal(factoryCalls, 3, 'third attempt should succeed')

  factoryCalls = 0
  const always = () => {
    factoryCalls += 1
    return { embed: async () => { throw new ModelUnavailableError('spawn EPERM') }, truncate: async text => ({ text }), dispose: () => {} }
  }
  const fellBack = await vectorRerank(candidates, routes, {
    mode: 'fields', indexDir: dir, records, routes, serverPath: 'fake-server', clientFactory: always,
  })
  assert.equal(fellBack.degraded, 'runtime-missing')
  assert.equal(factoryCalls, 3, 'gives up after three attempts')
  assert.match(fellBack.notice, /BM25/)
  assert.match(fellBack.notice, /Warn the user/)
}))
