/**
 * Optional vector rerank over the BM25 top-50.
 *
 * The model lives in a child process (the optional model package); this module
 * owns the fp16 caches, README excerpts, cosine similarity, and the RRF merge
 * with the lexical order.
 *
 * The ranking fuses up to three ranked lists with weighted RRF; weights are
 * mode-specific (RRF_WEIGHTS): fields mode BM25 1 : fields 0.35, readme mode
 * BM25 1 : fields 0.3 : README 0.4. `fields` (balance) has only the first two
 * lists; `readme` (high) computes both vector lists. A list a record is
 * missing contributes nothing, so a record without a README vector still
 * ranks through BM25 and its field vector.
 *
 * Modes:
 *   off     — no vectors, no model
 *   fields  — name/title/topics/capability/description vectors
 *   readme  — field vectors plus README excerpt vectors
 */
import { ModelClient, ModelUnavailableError, resolveModelServer } from './model-client.js'
import { VectorStore, decodeVector, hashText } from './vector-store.js'
import { cleanReadmeText, README_CLEAN_VERSION } from './readme-clean.js'
import {
  README_CONCURRENCY,
  README_RATE_PER_SECOND,
  README_RATE_BURST,
  README_REQUEST_TIMEOUT_MS,
  README_TOTAL_BUDGET_MS,
  NEGATIVE_CACHE_TTL_MS,
  RateLimiter,
  githubGuard,
  githubNotice,
  readmeTargets,
  fetchGithubReadme,
  fetchNpmReadme,
  resolveNpmVersion,
} from './readme-source.js'

const RRF_K = 60
const CACHE_TTL_MS = 90 * 86_400_000
const README_TOKEN_LIMIT = 384
const BATCH_SIZE = 64

/** Identifies the ranking algorithm in code, reports, and diagnostics. */
export const ALGORITHM_VERSION = 'v1.1'

/** gate2 default: max query-to-candidate cosine must exceed this to count as semantic evidence. */
export const GATE2_MAX_SIMILARITY = 0.85

/**
 * Weighted-RRF weights by mode (retuned 2026-10-25 on the real-usage set):
 * the field list is weak on near-duplicate clusters, the README list carries
 * high mode. A zero weight disables that list's contribution.
 */
export const RRF_WEIGHTS = Object.freeze({
  fields: Object.freeze({ bm25: 1, fields: 0.35, readme: 0 }),
  readme: Object.freeze({ bm25: 1, fields: 0.3, readme: 0.4 }),
})

let sharedClient = null

function getSharedClient(serverPath) {
  if (sharedClient && sharedClient.serverPath === serverPath && !sharedClient.closed) return sharedClient
  sharedClient = new ModelClient(serverPath)
  return sharedClient
}

/** Stop the idle model child (plugin unload or process shutdown). */
export function disposeVectorRuntime() {
  try { sharedClient?.dispose() } catch {}
  sharedClient = null
}

export function vectorRuntimeAvailable(indexDir) {
  return typeof indexDir === 'string' && resolveModelServer(indexDir) !== null
}

function fieldsText(record) {
  return [
    record.name,
    record.title,
    (record.topics ?? []).join(' '),
    (record.capability ?? []).join(' '),
    record.description,
  ].filter(value => typeof value === 'string' && value.trim() !== '').join('\n')
}

function fieldKey(record) {
  const contentHash = typeof record.contentHash === 'string' && record.contentHash !== ''
    ? record.contentHash
    : hashText(fieldsText(record))
  return `${record.id}:${contentHash}`
}

function fresh(entry, now, ttl = CACHE_TTL_MS) {
  return Boolean(entry && typeof entry.at === 'number' && now - entry.at < ttl)
}

function dot(a, b) {
  const length = Math.min(a.length, b.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index]
  return sum
}

/**
 * Weighted reciprocal-rank fusion. Ranks are 1-based; a missing list
 * contributes nothing. This keeps a record without a README vector eligible
 * through its BM25 and field-vector ranks instead of dropping it.
 */
export function weightedRrf(ranks, weights) {
  let score = 0
  for (const list of ['bm25', 'fields', 'readme']) {
    const rank = ranks?.[list]
    const weight = weights?.[list] ?? 0
    if (!Number.isFinite(rank) || rank < 1 || weight <= 0) continue
    score += weight / (RRF_K + rank)
  }
  return score
}

function topTwoAverage(similarities) {
  if (similarities.length === 0) return 0
  const sorted = [...similarities].sort((a, b) => b - a)
  return sorted.length >= 2 ? (sorted[0] + sorted[1]) / 2 : sorted[0]
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run(workerIndex) {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index, workerIndex)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, (_, index) => run(index))
  await Promise.all(workers)
  return results
}

function excerptSource(entry, key) {
  if (typeof entry?.source === 'string' && entry.source !== '') return entry.source
  return key.startsWith('npm:') ? 'npm-cdn' : 'github-raw'
}

async function finishExcerpt(fetched, key, client, store, now) {
  try {
    const cleaned = cleanReadmeText(fetched.text)
    if (cleaned.trim() === '') return null
    const truncated = await client.truncate(cleaned, README_TOKEN_LIMIT)
    if (typeof truncated.text !== 'string' || truncated.text.trim() === '') return null
    const excerpt = {
      text: truncated.text,
      hash: hashText(truncated.text),
      etag: fetched.etag ?? null,
      fetchedAt: now,
      source: fetched.source,
      cleanVersion: README_CLEAN_VERSION,
      ...(fetched.provider ? { provider: fetched.provider } : {}),
    }
    store.setExcerpt(key, excerpt)
    return { ...excerpt, at: Date.now() }
  } catch {
    return null
  }
}

async function readmeExcerpt(record, client, store, now, {
  fetchImpl,
  limiter,
  githubDeadline,
  requestTimeoutMs = README_REQUEST_TIMEOUT_MS,
}) {
  const { github, npm } = readmeTargets(record)
  const githubKey = github?.key ?? ''
  const githubCached = githubKey ? store.getExcerpt(githubKey) : null
  const githubCurrent = Boolean(
    githubCached && !githubCached.noReadme
    && githubCached.cleanVersion === README_CLEAN_VERSION
    && fresh(githubCached, now),
  )
  if (githubCurrent) {
    return { ...githubCached, source: excerptSource(githubCached, githubKey) }
  }
  const githubNegative = Boolean(
    githubCached?.noReadme && fresh(githubCached, now, NEGATIVE_CACHE_TTL_MS),
  )
  let stale = githubCached && !githubCached.noReadme
    && githubCached.cleanVersion === README_CLEAN_VERSION
    ? githubCached
    : null

  let npmVersion = npm?.version ?? null
  let npmKey = npmVersion ? `npm:${npm.name}@${npmVersion}` : ''
  let npmCached = npmKey ? store.getExcerpt(npmKey) : null
  const npmNegative = Boolean(
    npmCached?.noReadme && fresh(npmCached, now, NEGATIVE_CACHE_TTL_MS),
  )

  if (github && !githubNegative && Date.now() < githubDeadline && githubGuard.canUse()) {
    const revalidate = githubCached && !githubCached.noReadme
      && githubCached.cleanVersion === README_CLEAN_VERSION
      ? githubCached
      : null
    const result = await fetchGithubReadme(github, {
      fetchImpl,
      limiter,
      timeoutMs: requestTimeoutMs,
      etag: revalidate?.etag ?? null,
    })
    if (result.notModified && revalidate) {
      githubGuard.recordSuccess()
      store.setExcerpt(githubKey, { ...revalidate, fetchedAt: now, source: 'github-raw' })
      return { ...revalidate, at: Date.now(), fetchedAt: now, source: 'github-raw' }
    }
    if (result.status === 200 && typeof result.text === 'string') {
      githubGuard.recordSuccess()
      const excerpt = await finishExcerpt(result, githubKey, client, store, now)
      if (excerpt) return excerpt
    } else if (result.status === 404 || result.empty) {
      githubGuard.recordSuccess()
      store.setExcerpt(githubKey, { noReadme: true, source: 'github-raw' })
    } else if (result.rateLimited) {
      githubGuard.recordSuccess()
      githubGuard.recordRateLimit(Date.now(), result.retryAfterMs ?? 0)
    } else if (result.network || result.transport) {
      githubGuard.recordTransportFailure(result.timeout ? 'timeout' : 'transport')
    }
  }

  if (npm && !npmNegative) {
    if (!npmVersion) {
      npmVersion = await resolveNpmVersion(npm.name, {
        fetchImpl,
        limiter,
        timeoutMs: requestTimeoutMs,
        now: () => Date.now(),
      })
      if (npmVersion) {
        npmKey = `npm:${npm.name}@${npmVersion}`
        npmCached = store.getExcerpt(npmKey)
      }
    }
    if (npmVersion) {
      if (npmCached && !npmCached.noReadme && npmCached.cleanVersion === README_CLEAN_VERSION) {
        if (fresh(npmCached, now)) {
          return { ...npmCached, source: excerptSource(npmCached, npmKey) }
        }
        stale ??= npmCached
      }
      if (npmCached?.noReadme && fresh(npmCached, now, NEGATIVE_CACHE_TTL_MS)) return stale
      const result = await fetchNpmReadme(npm.name, npmVersion, {
        fetchImpl,
        limiter,
        timeoutMs: requestTimeoutMs,
        etag: npmCached && npmCached.cleanVersion === README_CLEAN_VERSION ? npmCached.etag : null,
      })
      if (result.notModified && npmCached && npmCached.cleanVersion === README_CLEAN_VERSION) {
        store.setExcerpt(npmKey, { ...npmCached, fetchedAt: now, source: 'npm-cdn' })
        return { ...npmCached, at: Date.now(), fetchedAt: now, source: 'npm-cdn' }
      }
      if (result.status === 200 && typeof result.text === 'string') {
        const excerpt = await finishExcerpt(result, npmKey, client, store, now)
        if (excerpt) return excerpt
      } else if (result.status === 404 || result.empty) {
        store.setExcerpt(npmKey, { noReadme: true, source: 'npm-cdn' })
      }
    }
  }
  return stale
}

async function fillFields({ records, candidates, client, store, vectors, now }) {
  const missing = []
  for (const entry of candidates) {
    const record = records[entry.doc]
    const key = fieldKey(record)
    const cached = store.getField(key)
    if (fresh(cached, now)) {
      vectors.set(entry.doc, decodeVector(cached.v))
      continue
    }
    missing.push({ entry, record, key, text: fieldsText(record) })
  }
  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    const batch = missing.slice(offset, offset + BATCH_SIZE)
    const started = Date.now()
    const result = await client.embed(batch.map(item => item.text), 'passage')
    if (process.env.DSH_VECTOR_DEBUG) {
      const chars = batch.reduce((sum, item) => sum + item.text.length, 0)
      console.error(`[vector] fields batch ${batch.length} texts, ${chars} chars, ${Date.now() - started} ms`)
    }
    for (let index = 0; index < batch.length; index += 1) {
      const vector = result[index]
      if (!vector) continue
      vectors.set(batch[index].entry.doc, vector)
      store.setField(batch[index].key, vector, batch[index].record.contentHash ?? null)
    }
  }
}

async function fillReadme({
  records,
  candidates,
  client,
  store,
  vectors,
  now,
  fetchImpl,
  readmeOptions = null,
  readmeTotalBudgetMs = README_TOTAL_BUDGET_MS,
}) {
  githubGuard.beginRound(Date.now())
  const concurrency = Math.max(1, Math.round(
    Number(readmeOptions?.concurrency) || README_CONCURRENCY,
  ))
  const requestTimeoutMs = Math.max(1000,
    Number(readmeOptions?.requestTimeoutMs) || README_REQUEST_TIMEOUT_MS)
  const totalBudgetMs = readmeOptions?.totalBudgetMs !== undefined && readmeOptions?.totalBudgetMs !== null
    ? Math.max(0, Number(readmeOptions.totalBudgetMs))
    : readmeTotalBudgetMs
  const githubDeadline = Date.now() + totalBudgetMs
  const limiters = Array.from({ length: concurrency }, () => new RateLimiter({
    rate: README_RATE_PER_SECOND,
    burst: README_RATE_BURST,
  }))
  const tasks = candidates.map(entry => async workerIndex => {
    const record = records[entry.doc]
    const excerpt = await readmeExcerpt(record, client, store, now, {
      fetchImpl,
      limiter: limiters[workerIndex],
      githubDeadline,
      requestTimeoutMs,
    })
    if (!excerpt) return null
    return { entry, record, excerpt, key: `${record.id}:${excerpt.hash}` }
  })
  const resolved = (await mapLimit(
    tasks,
    concurrency,
    (task, _index, workerIndex) => task(workerIndex),
  )).filter(Boolean)
  const readmeSources = { github: 0, npm: 0, fields: 0 }
  for (const item of resolved) {
    if (item.excerpt.source === 'npm-cdn') readmeSources.npm += 1
    else readmeSources.github += 1
  }
  const missing = []
  let readmeCovered = 0
  for (const item of resolved) {
    const cached = store.getReadme(item.key)
    if (fresh(cached, now)) {
      vectors.set(item.entry.doc, decodeVector(cached.v))
      readmeCovered += 1
    } else {
      missing.push(item)
    }
  }
  for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
    const batch = missing.slice(offset, offset + BATCH_SIZE)
    const result = await client.embed(batch.map(item => item.excerpt.text), 'passage')
    for (let index = 0; index < batch.length; index += 1) {
      const vector = result[index]
      if (!vector) continue
      vectors.set(batch[index].entry.doc, vector)
      store.setReadme(batch[index].key, vector, batch[index].excerpt.hash)
      readmeCovered += 1
    }
  }

  // No field fallback here: the field list stays separate, so a record
  // without a README vector still contributes through its field vector. The
  // counter is coverage diagnostics only.
  const readmeFallback = Math.max(0, candidates.length - readmeCovered)
  readmeSources.fields = readmeFallback
  const circuit = githubGuard.status()
  return {
    readmeCovered,
    readmeFallback,
    readmeSources,
    ...(circuit ? { circuit, notice: githubNotice(circuit.reason) } : {}),
  }
}

function degraded(mode, reason, candidates, error) {
  const notice = degradationNotice(mode, reason, error)
  return {
    mode,
    algorithm: ALGORITHM_VERSION,
    covered: 0,
    degraded: reason,
    ...(error ? { error } : {}),
    ...(notice ? { notice } : {}),
    candidates,
  }
}

/** English notice so the session LLM can warn the user about the fallback. */
function degradationNotice(mode, reason, error) {
  if (reason === 'runtime-missing') {
    return `Vector rerank (mode "${mode}") was skipped: the local embedding model could not be started${error ? ` (${error})` : ''}. Results are lexical (BM25) only. Warn the user that vector enhancement degraded; suggest checking that the optional model package (dsh-plugin-discover-model) is installed and runnable, or setting vector.mode to "off".`
  }
  if (reason === 'embedding-failed') {
    return `Vector rerank (mode "${mode}") failed while embedding: ${error ?? 'unknown error'}. Results are lexical (BM25) only. Warn the user that vector enhancement degraded for this query.`
  }
  return null
}

const MODEL_ATTEMPTS = 3
const MODEL_RETRY_DELAYS_MS = [0, 800, 2000]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Rerank the grouped BM25 top-50 with weighted RRF over the BM25, field-vector,
 * and — in readme mode — README-vector lists (weights: RRF_WEIGHTS by mode).
 * @param {object[]} candidates grouped candidates in lexical order
 * @param {object[]} routes prepared query routes (original + rewrites)
 * @param {object} options
 */
export async function vectorRerank(candidates, routes, {
  mode = 'off',
  gate2Threshold = GATE2_MAX_SIMILARITY,
  indexDir = null,
  records = [],
  now = Date.now(),
  clientFactory = null,
  fetchImpl = null,
  serverPath = null,
  disposeClient = true,
  readmeOptions = null,
  readmeTotalBudgetMs = README_TOTAL_BUDGET_MS,
} = {}) {
  if (mode !== 'fields' && mode !== 'readme') return null
  const selectedGate2Threshold = Number.isFinite(Number(gate2Threshold))
    ? Number(gate2Threshold)
    : GATE2_MAX_SIMILARITY
  if (typeof indexDir !== 'string' || indexDir === '') return degraded(mode, 'index-dir-missing', candidates, null)
  const resolvedServer = serverPath ?? resolveModelServer(indexDir)
  if (!resolvedServer) return degraded(mode, 'runtime-missing', candidates, 'model package is not installed')
  const store = new VectorStore(indexDir)
  const fetchReader = fetchImpl ?? globalThis.fetch

  async function attempt(client) {
    const texts = routes
      .map(route => (typeof route.text === 'string' && route.text !== '' ? route.text : (route.terms ?? []).join(' ')))
      .filter(text => text !== '')
    if (texts.length === 0) return degraded(mode, 'no-query-vectors', candidates, null)
    const queryVectors = await client.embed(texts, 'query')
    if (!queryVectors.length) return degraded(mode, 'no-query-vectors', candidates, null)

    const fieldVectors = new Map()
    const readmeVectors = new Map()
    let readmeState = null
    // Field vectors are cheap and always computed; the README list is an
    // additional, independent list in `readme` mode.
    await fillFields({ records, candidates, client, store, vectors: fieldVectors, now })
    if (mode === 'readme') {
      readmeState = await fillReadme({
        records, candidates, client, store, vectors: readmeVectors, now, fetchImpl: fetchReader,
        readmeOptions,
        readmeTotalBudgetMs,
      })
    }

    const scored = candidates.map((entry, bm25Rank) => {
      const fieldVector = fieldVectors.get(entry.doc) ?? null
      const readmeVector = readmeVectors.get(entry.doc) ?? null
      const fieldSimilarities = fieldVector
        ? queryVectors.map(query => dot(fieldVector, query))
        : []
      const readmeSimilarities = readmeVector
        ? queryVectors.map(query => dot(readmeVector, query))
        : []
      const fieldSimilarity = fieldSimilarities.length ? topTwoAverage(fieldSimilarities) : null
      const readmeSimilarity = readmeSimilarities.length ? topTwoAverage(readmeSimilarities) : null
      const fieldMax = fieldSimilarities.length ? Math.max(...fieldSimilarities) : null
      const readmeMax = readmeSimilarities.length ? Math.max(...readmeSimilarities) : null
      const gate2MaxSimilarity = mode === 'readme'
        ? Math.max(fieldMax ?? -Infinity, readmeMax ?? -Infinity)
        : (fieldMax ?? -Infinity)
      return {
        entry,
        bm25Rank,
        fieldVector,
        readmeVector,
        fieldSimilarity,
        readmeSimilarity,
        fieldMaxSimilarity: fieldMax,
        readmeMaxSimilarity: readmeMax,
        gate2MaxSimilarity,
      }
    })
    const fieldOrder = scored
      .filter(item => item.fieldVector)
      .sort((a, b) => b.fieldSimilarity - a.fieldSimilarity
        || a.bm25Rank - b.bm25Rank
        || a.entry.doc - b.entry.doc)
    const fieldRank = new Map(fieldOrder.map((item, index) => [item.entry.doc, index + 1]))
    const readmeOrder = scored
      .filter(item => item.readmeVector)
      .sort((a, b) => b.readmeSimilarity - a.readmeSimilarity
        || a.bm25Rank - b.bm25Rank
        || a.entry.doc - b.entry.doc)
    const readmeRank = new Map(readmeOrder.map((item, index) => [item.entry.doc, index + 1]))

    const weights = RRF_WEIGHTS[mode]
    for (const item of scored) {
      const fieldRankValue = fieldRank.get(item.entry.doc)
      const readmeRankValue = readmeRank.get(item.entry.doc)
      const gate2Max = Number.isFinite(item.gate2MaxSimilarity) ? item.gate2MaxSimilarity : null
      item.entry.gate2MaxSimilarity = gate2Max
      item.entry.gate2Pass = gate2Max !== null && gate2Max > selectedGate2Threshold
      item.entry.fieldMaxSimilarity = item.fieldMaxSimilarity
      item.entry.readmeMaxSimilarity = item.readmeMaxSimilarity
      // Ranks are 1-based; a missing list contributes nothing.
      item.entry.score = weightedRrf({
        bm25: item.bm25Rank + 1,
        fields: fieldRankValue,
        readme: readmeRankValue,
      }, weights)
      item.entry.vectorSimilarity = mode === 'readme'
        ? (item.readmeSimilarity ?? item.fieldSimilarity)
        : item.fieldSimilarity
      item.entry.fieldSimilarity = item.fieldSimilarity
      item.entry.readmeSimilarity = item.readmeSimilarity
      item.entry.fieldRank = fieldRankValue ?? null
      item.entry.readmeRank = readmeRankValue ?? null
    }
    const ordered = scored
      .slice()
      .sort((a, b) => b.entry.score - a.entry.score
        || a.bm25Rank - b.bm25Rank
        || a.entry.doc - b.entry.doc)
      .map(item => item.entry)
    const covered = scored.filter(item => item.fieldVector || item.readmeVector).length
    if (covered === 0) return degraded(mode, 'no-vectors', candidates, null)
    const gate2Values = scored
      .map(item => item.gate2MaxSimilarity)
      .filter(value => Number.isFinite(value))
    const gate2MaxSimilarity = gate2Values.length ? Math.max(...gate2Values) : null
    const gate2 = {
      threshold: selectedGate2Threshold,
      maxSimilarity: gate2MaxSimilarity,
      passed: gate2MaxSimilarity !== null && gate2MaxSimilarity > selectedGate2Threshold,
    }
    return {
      mode,
      algorithm: ALGORITHM_VERSION,
      covered,
      fieldCovered: fieldOrder.length,
      gate2,
      candidates: ordered,
      ...(mode === 'readme' ? readmeState : {}),
    }
  }

  // Retry with a fresh model process so a transient spawn failure does not
  // silently degrade to lexical-only results; caches make retries cheap.
  let lastError = null
  try {
    for (let round = 0; round < MODEL_ATTEMPTS; round += 1) {
      if (MODEL_RETRY_DELAYS_MS[round] > 0) await sleep(MODEL_RETRY_DELAYS_MS[round])
      const ephemeral = Boolean(clientFactory) || disposeClient
      const client = clientFactory
        ? clientFactory(resolvedServer)
        : (ephemeral ? new ModelClient(resolvedServer) : getSharedClient(resolvedServer))
      try {
        return await attempt(client)
      } catch (error) {
        if (!(error instanceof ModelUnavailableError)) {
          return degraded(mode, 'embedding-failed', candidates, error instanceof Error ? error.message : String(error))
        }
        lastError = error
        try { client.dispose?.() } catch {}
        if (!ephemeral && sharedClient === client) sharedClient = null
      } finally {
        if (ephemeral) {
          try { client.dispose?.() } catch {}
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'model unavailable')
    return degraded(mode, 'runtime-missing', candidates, message)
  } finally {
    try { store.flush() } catch {}
  }
}
