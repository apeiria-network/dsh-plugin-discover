import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { record } from './fixtures.js'
import {
  GithubGuard,
  RateLimiter,
  githubGuard,
  githubNotice,
  parseGithubTarget,
  parseNpmTarget,
  fetchGithubReadme,
  fetchNpmReadme,
} from '../lib/readme-source.js'
import { vectorRerank } from '../lib/vector.js'
import { textReport } from '../lib/report.js'
import { VectorStore, hashText } from '../lib/vector-store.js'
import { README_CLEAN_VERSION } from '../lib/readme-clean.js'

function vectorFor(text) {
  return String(text).toLowerCase().includes('sidebar') ? Float32Array.from([1, 0]) : Float32Array.from([0, 1])
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
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-readme-'))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function response(status, text = '', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  }
}

test('targets parse GitHub refs and scoped npm versions', () => {
  assert.deepEqual(
    parseGithubTarget({ install: { target: 'github:acme/repo#v1.2.3' }, repo: '' }),
    { owner: 'acme', name: 'repo', ref: 'v1.2.3', key: 'github:acme/repo@v1.2.3' },
  )
  assert.deepEqual(
    parseNpmTarget({ install: { target: '@scope/name@1.2.3' }, name: 'name' }),
    { name: '@scope/name', version: '1.2.3', key: 'npm:@scope/name@1.2.3' },
  )
  assert.deepEqual(
    parseNpmTarget({ install: { target: '@scope/name' }, name: 'name' }),
    { name: '@scope/name', version: null, key: 'npm:@scope/name@latest' },
  )
})

test('each worker is limited to one request per second', async () => {
  let now = 0
  const waits = []
  const limiter = new RateLimiter({
    now: () => now,
    sleep: async ms => {
      waits.push(ms)
      now += ms
    },
  })
  await limiter.take()
  assert.equal(waits.length, 0, 'first request should not wait')
  await limiter.take()
  assert.ok(waits[0] >= 950, `second request should wait about 1000ms, got ${waits[0]}`)
})

test('GitHub guard opens on three timeouts and on three rate limits', () => {
  let now = 0
  const guard = new GithubGuard({ now: () => now, cooldownMs: 1000 })
  guard.beginRound()
  guard.recordTransportFailure('timeout')
  guard.recordTransportFailure('timeout')
  assert.equal(guard.status(), null)
  guard.recordTransportFailure('timeout')
  assert.equal(guard.status().reason, 'timeout')
  assert.match(githubNotice('timeout'), /timed out/i)

  guard.reset()
  now = 10_000
  guard.beginRound()
  guard.recordRateLimit()
  guard.recordRateLimit()
  assert.equal(guard.status(), null)
  guard.recordRateLimit()
  assert.equal(guard.status().reason, 'rate-limit')
  assert.match(githubNotice('rate-limit'), /rate-limited/i)
})

test('GitHub fetch uses the pinned ref, and npm falls back to jsDelivr', async () => {
  const urls = []
  const github = await fetchGithubReadme(
    { owner: 'acme', name: 'repo', ref: 'v1', key: 'github:acme/repo@v1' },
    {
      limiter: null,
      fetchImpl: async url => {
        urls.push(url)
        return response(200, 'github readme')
      },
    },
  )
  assert.equal(github.source, 'github-raw')
  assert.ok(urls[0].includes('/acme/repo/v1/README.md'))

  const npmUrls = []
  const npm = await fetchNpmReadme('@scope/name', '1.2.3', {
    limiter: null,
    fetchImpl: async url => {
      npmUrls.push(url)
      if (url.includes('unpkg.com')) return response(404)
      return response(200, 'npm readme')
    },
  })
  assert.equal(npm.source, 'npm-cdn')
  assert.equal(npm.provider, 'jsdelivr')
  assert.ok(npmUrls.some(url => url.includes('cdn.jsdelivr.net/npm/@scope/name@1.2.3/README.md')))
})

test('readme mode goes GitHub 404 → npm CDN → vector', () => withDir(async dir => {
  githubGuard.reset()
  const records = [
    record({
      id: 'a',
      name: 'a',
      description: 'A sidebar UI tool.',
      repo: 'https://github.com/acme/a',
      install: { target: 'dsh-im-connect' },
    }),
  ]
  const candidates = [{ doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] }]
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    if (url.includes('raw.githubusercontent.com')) return response(404)
    if (url.includes('registry.npmjs.org')) return response(200, JSON.stringify({ 'dist-tags': { latest: '1.2.3' } }))
    if (url.includes('unpkg.com')) return response(200, 'A sidebar UI README')
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(value.readmeCovered, 1)
  assert.equal(value.readmeSources.npm, 1)
  assert.equal(value.readmeSources.github, 0)
  assert.equal(value.readmeFallback, 0)
  assert.ok(calls.some(url => url.includes('unpkg.com/@scope') || url.includes('unpkg.com/dsh-im-connect')))
}))

test('a fresh npm cache is used only after GitHub fails', () => withDir(async dir => {
  githubGuard.reset()
  const records = ['g', 'n'].map(name => record({
    id: name,
    name,
    description: 'A sidebar UI tool.',
    repo: `https://github.com/acme/${name}`,
    install: { target: `@scope/${name}@1.0.0` },
  }))
  const store = new VectorStore(dir)
  const seededAt = Date.now()
  for (const name of ['g', 'n']) {
    const text = `cached npm readme for ${name} sidebar`
    store.setExcerpt(`npm:@scope/${name}@1.0.0`, {
      text,
      hash: hashText(text),
      etag: null,
      fetchedAt: seededAt,
      source: 'npm-cdn',
      provider: 'unpkg',
      cleanVersion: README_CLEAN_VERSION,
    })
  }
  store.flush()
  const candidates = records.map((_, index) => ({ doc: index, score: 0.02 - index * 0.01, from: 'query', matched: 1, extras: [] }))
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const calls = []
  const fetchImpl = async url => {
    calls.push(url)
    if (url.includes('raw.githubusercontent.com/acme/g/')) return response(200, 'github readme for g sidebar')
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(value.readmeSources.github, 1)
  assert.equal(value.readmeSources.npm, 1)
  assert.ok(calls.some(url => url.includes('raw.githubusercontent.com/acme/g/')), 'GitHub is fetched despite the fresh npm cache')
  assert.ok(!calls.some(url => url.includes('unpkg.com') || url.includes('cdn.jsdelivr.net') || url.includes('registry.npmjs.org')), 'fresh npm cache must be reused without refetching')
  githubGuard.reset()
}))

test('an expired GitHub cache revalidates with If-None-Match and keeps the excerpt on 304', () => withDir(async dir => {
  githubGuard.reset()
  const records = [record({
    id: 'rv',
    name: 'rv',
    description: 'A sidebar UI tool.',
    repo: 'https://github.com/acme/rv',
    install: { target: 'dsh-im-connect' },
  })]
  const store = new VectorStore(dir)
  const text = 'stale cached github readme sidebar'
  store.setExcerpt('github:acme/rv@HEAD', {
    text,
    hash: hashText(text),
    etag: 'etag-1',
    fetchedAt: Date.now(),
    source: 'github-raw',
    cleanVersion: README_CLEAN_VERSION,
  })
  store.flush()
  const shiftedNow = Date.now() + 91 * 86_400_000
  const candidates = [{ doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] }]
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  let etagSeen = null
  const fetchImpl = async (url, options) => {
    if (url.includes('raw.githubusercontent.com')) {
      etagSeen = options?.headers?.['if-none-match'] ?? null
      return response(304)
    }
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    now: shiftedNow,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(etagSeen, 'etag-1')
  assert.equal(value.readmeSources.github, 1)
  assert.equal(value.readmeCovered, 1)
  const reread = new VectorStore(dir)
  assert.equal(reread.getExcerpt('github:acme/rv@HEAD').fetchedAt, shiftedNow)
  githubGuard.reset()
}))

test('one GitHub 403 skips only that record and keeps other GitHub READMEs', () => withDir(async dir => {
  githubGuard.reset()
  const records = [0, 1, 2, 3].map(index => record({
    id: `p${index}`,
    name: `p${index}`,
    description: 'A sidebar UI tool.',
    repo: `https://github.com/acme/p${index}`,
    install: { target: 'dsh-im-connect' },
  }))
  const candidates = records.map((_, index) => ({ doc: index, score: 0.04 - index * 0.01 }))
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const fetchImpl = async url => {
    if (url.includes('raw.githubusercontent.com/acme/p0/')) return response(403)
    if (url.includes('raw.githubusercontent.com')) return response(200, 'A sidebar UI README')
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(value.readmeCovered, 3)
  assert.equal(value.readmeSources.github, 3)
  assert.equal(value.readmeFallback, 1)
  assert.equal(value.circuit, undefined)
  assert.equal(value.notice, undefined)
  githubGuard.reset()
}))

test('the total README budget skips remaining GitHub fetches and goes to npm CDN', () => withDir(async dir => {
  githubGuard.reset()
  const records = [record({
    id: 'budget',
    name: 'budget',
    description: 'A sidebar UI tool.',
    repo: 'https://github.com/acme/budget',
    install: { target: '@scope/budget@1.2.3' },
  })]
  const candidates = [{ doc: 0, score: 0.02, from: 'query', matched: 1, extras: [] }]
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  let rawCalls = 0
  const fetchImpl = async url => {
    if (url.includes('raw.githubusercontent.com')) {
      rawCalls += 1
      return response(200, 'github readme')
    }
    if (url.includes('registry.npmjs.org')) return response(200, JSON.stringify({ 'dist-tags': { latest: '1.2.3' } }))
    if (url.includes('unpkg.com')) return response(200, 'npm readme')
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
    readmeOptions: { totalBudgetMs: 0, concurrency: 1, requestTimeoutMs: 5000 },
  })
  assert.equal(rawCalls, 0, 'expired total budget must skip GitHub')
  assert.equal(value.readmeSources.npm, 1)
  assert.equal(value.readmeCovered, 1)
  githubGuard.reset()
}))

test('three GitHub 403s open the rate-limit circuit and produce an English notice', () => withDir(async dir => {
  githubGuard.reset()
  const records = [0, 1, 2].map(index => record({
    id: `r${index}`,
    name: `r${index}`,
    description: 'A sidebar UI tool.',
    repo: `https://github.com/acme/r${index}`,
    install: { target: 'dsh-im-connect' },
  }))
  const candidates = records.map((_, index) => ({ doc: index, score: 0.03 - index * 0.01 }))
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const fetchImpl = async url => {
    if (url.includes('raw.githubusercontent.com')) return response(403, '', { 'retry-after': '0' })
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(value.circuit.open, true)
  assert.equal(value.circuit.reason, 'rate-limit')
  assert.match(value.notice, /rate-limited/i)
  assert.match(githubNotice('rate-limit'), /10 minutes/)
}))

test('three GitHub timeouts open the timeout circuit and the report shows the notice', () => withDir(async dir => {
  githubGuard.reset()
  const records = [0, 1, 2].map(index => record({
    id: `t${index}`,
    name: `t${index}`,
    description: 'A sidebar UI tool.',
    repo: `https://github.com/acme/t${index}`,
    install: { target: 'dsh-im-connect' },
  }))
  const candidates = records.map((_, index) => ({ doc: index, score: 0.03 - index * 0.01 }))
  const routes = [{ text: 'sidebar', terms: ['sidebar'] }]
  const counters = { query: 0, passage: 0, truncate: 0, dispose: 0 }
  const fetchImpl = async url => {
    if (url.includes('raw.githubusercontent.com')) {
      const error = new Error('timeout')
      error.name = 'TimeoutError'
      throw error
    }
    return response(404)
  }
  const value = await vectorRerank(candidates, routes, {
    mode: 'readme',
    indexDir: dir,
    records,
    serverPath: 'fake-server',
    clientFactory: () => fakeClient(counters),
    fetchImpl,
    disposeClient: true,
  })
  assert.equal(value.circuit.open, true)
  assert.equal(value.circuit.reason, 'timeout')
  assert.match(value.notice, /timed out/i)
  const report = textReport({
    results: [{ name: 'r', description: 'd', install: { target: 'r' }, badges: {} }],
    interpreted: {},
    filterStats: {},
    vector: value,
  }, {})
  assert.ok(report.startsWith('⚠️ '), report.split('\n')[0])
  assert.match(report, /timed out/i)
}))
