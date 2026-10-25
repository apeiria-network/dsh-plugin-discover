/**
 * README source resolution for readme-mode vectors.
 *
 * Order: GitHub raw (native network) -> npm CDN (exact published version) ->
 * field-vector fallback in vector.js. GitHub is never sent through a proxy.
 */
export const README_REQUEST_TIMEOUT_MS = 30_000
export const README_TOTAL_BUDGET_MS = 5 * 60_000
export const README_CONCURRENCY = 4
export const README_RATE_PER_SECOND = 1
export const README_RATE_BURST = 1
export const README_JITTER_MIN_MS = 50
export const README_JITTER_MAX_MS = 150
export const CIRCUIT_COOLDOWN_MS = 10 * 60_000
export const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60_000
export const GITHUB_HOST = 'raw.githubusercontent.com'
export const USER_AGENT = 'dsh-plugin-discover/0.1.0'

const GITHUB_FILENAMES = ['README.md', 'readme.md']
const NPM_PROVIDERS = [
  ['unpkg', 'https://unpkg.com'],
  ['jsdelivr', 'https://cdn.jsdelivr.net/npm'],
]

export const README_NOTICES = {
  timeout: 'GitHub README requests timed out repeatedly. GitHub access is paused for 10 minutes; remaining READMEs fall back to the npm CDN or field vectors.',
  'rate-limit': 'GitHub README requests were rate-limited (HTTP 403/429). GitHub access is paused for 10 minutes; remaining READMEs fall back to the npm CDN or field vectors.',
  transport: 'GitHub README requests failed repeatedly. GitHub access is paused for 10 minutes; remaining READMEs fall back to the npm CDN or field vectors.',
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One token bucket per worker; four workers therefore cap at 4 req/s. */
export class RateLimiter {
  constructor({
    rate = README_RATE_PER_SECOND,
    burst = README_RATE_BURST,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (!(rate > 0)) throw new Error('rate must be positive')
    this.rate = rate
    this.capacity = Math.max(1, burst)
    this.tokens = this.capacity
    this.updated = now()
    this.now = now
    this.sleep = sleep
  }

  refill(now) {
    const elapsed = (now - this.updated) / 1000
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate)
    this.updated = now
  }

  async take() {
    for (;;) {
      const now = this.now()
      this.refill(now)
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const wait = Math.max(1, Math.ceil(((1 - this.tokens) / this.rate) * 1000))
      await this.sleep(wait)
    }
  }
}

/** Small jitter so four workers do not burst at the same millisecond. */
export async function jitter(sleep = defaultSleep, min = README_JITTER_MIN_MS, max = README_JITTER_MAX_MS) {
  if (max <= 0) return
  await sleep(min + Math.random() * Math.max(0, max - min))
}

/**
 * GitHub circuit breaker. A success resets the transport-failure run.
 * 403/429 are counted separately per round; the third opens the same cooldown.
 */
export class GithubGuard {
  constructor({
    now = () => Date.now(),
    cooldownMs = CIRCUIT_COOLDOWN_MS,
    threshold = 3,
  } = {}) {
    this.now = now
    this.cooldownMs = cooldownMs
    this.threshold = threshold
    this.openUntil = 0
    this.reason = null
    this.transportFailures = 0
    this.rateLimitHits = 0
    this.sawTimeout = false
  }

  beginRound(now = this.now()) {
    this.transportFailures = 0
    this.rateLimitHits = 0
    this.sawTimeout = false
    this.expire(now)
  }

  expire(now) {
    if (this.openUntil && now >= this.openUntil) {
      this.openUntil = 0
      this.reason = null
      this.transportFailures = 0
      this.rateLimitHits = 0
      this.sawTimeout = false
    }
  }

  canUse(now = this.now()) {
    this.expire(now)
    return this.openUntil === 0
  }

  recordSuccess() {
    this.transportFailures = 0
  }

  recordTransportFailure(kind = 'transport', now = this.now()) {
    if (!this.canUse(now)) return
    if (kind === 'timeout') this.sawTimeout = true
    this.transportFailures += 1
    if (this.transportFailures >= this.threshold) {
      this.open(now, this.sawTimeout ? 'timeout' : 'transport')
    }
  }

  recordRateLimit(now = this.now(), retryAfterMs = 0) {
    if (!this.canUse(now)) return
    this.rateLimitHits += 1
    if (this.rateLimitHits >= this.threshold) {
      this.open(now, 'rate-limit', Math.max(this.cooldownMs, retryAfterMs))
    }
  }

  open(now, reason, cooldown = this.cooldownMs) {
    this.openUntil = now + cooldown
    this.reason = reason
  }

  status(now = this.now()) {
    this.expire(now)
    if (!this.openUntil) return null
    return {
      open: true,
      reason: this.reason,
      host: GITHUB_HOST,
      until: new Date(this.openUntil).toISOString(),
    }
  }

  reset() {
    this.openUntil = 0
    this.reason = null
    this.transportFailures = 0
    this.rateLimitHits = 0
    this.sawTimeout = false
  }
}

export const githubGuard = new GithubGuard()

export function githubNotice(reason) {
  return README_NOTICES[reason] ?? README_NOTICES.transport
}

function stripGit(value) {
  return String(value).replace(/\.git$/i, '')
}

export function parseGithubTarget(record) {
  const target = typeof record?.install?.target === 'string' ? record.install.target : ''
  const repo = typeof record?.repo === 'string' ? record.repo : ''
  let owner = ''
  let name = ''
  let ref = 'HEAD'
  const direct = /^github:([^/#]+)\/([^#]+?)(?:#(.+))?$/i.exec(target)
  if (direct) {
    owner = direct[1]
    name = stripGit(direct[2])
    ref = direct[3] || 'HEAD'
  } else {
    const match = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(repo)
      || /github\.com\/([^/]+)\/([^/#?]+)/i.exec(target)
    if (match) {
      owner = match[1]
      name = stripGit(match[2])
    }
  }
  if (!owner || !name) return null
  return { owner, name, ref, key: `github:${owner}/${name}@${ref}` }
}

function splitNpmSpec(spec) {
  if (typeof spec !== 'string' || spec === '') return null
  let name = spec
  let version = null
  const at = spec.lastIndexOf('@')
  if (at > 0) {
    name = spec.slice(0, at)
    version = spec.slice(at + 1) || null
  }
  if (!name || name.includes('://') || name.includes(':')) return null
  if (name.includes('/') && !name.startsWith('@')) return null
  if (version === 'latest') version = null
  return { name, version }
}

export function parseNpmTarget(record) {
  const target = typeof record?.install?.target === 'string' ? record.install.target : ''
  const lower = target.toLowerCase()
  let spec = ''
  if (target && !lower.startsWith('github:') && !lower.startsWith('file:') && !lower.startsWith('link:') && !lower.startsWith('http')) {
    spec = target
  } else {
    spec = typeof record?.alias === 'string' && record.alias !== '' ? record.alias : record?.name
  }
  const parsed = splitNpmSpec(spec)
  if (!parsed) return null
  return {
    ...parsed,
    key: `npm:${parsed.name}@${parsed.version ?? 'latest'}`,
  }
}

export function readmeTargets(record) {
  return {
    github: parseGithubTarget(record),
    npm: parseNpmTarget(record),
  }
}

const npmVersionCache = new Map()

function cacheFresh(entry, now, ttl) {
  return Boolean(entry && now - entry.at < ttl)
}

export async function resolveNpmVersion(name, {
  fetchImpl,
  limiter = null,
  sleep = defaultSleep,
  timeoutMs = README_REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
  etag = null,
} = {}) {
  const at = now()
  const cached = npmVersionCache.get(name)
  const ttl = cached?.version ? 10 * 60_000 : NEGATIVE_CACHE_TTL_MS
  if (cacheFresh(cached, at, ttl)) return cached?.version ?? null
  const result = await requestText(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    { fetchImpl, limiter, sleep, timeoutMs, etag, accept: 'application/json' },
  )
  if (result.status === 404) {
    npmVersionCache.set(name, { version: null, at })
    return null
  }
  if (typeof result.text !== 'string') return cached?.version ?? null
  try {
    const pkg = JSON.parse(result.text)
    const version = pkg?.['dist-tags']?.latest
    if (typeof version === 'string' && version !== '') {
      npmVersionCache.set(name, { version, at })
      return version
    }
  } catch {}
  return cached?.version ?? null
}

function retryAfterMs(response) {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

async function requestText(url, {
  fetchImpl,
  limiter = null,
  sleep = defaultSleep,
  timeoutMs = README_REQUEST_TIMEOUT_MS,
  etag = null,
  accept = 'text/plain',
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { network: true, error: 'fetch-unavailable' }
  }
  if (limiter) await limiter.take()
  await jitter(sleep)
  const headers = { 'user-agent': USER_AGENT, accept }
  if (etag) headers['if-none-match'] = etag
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 304) return { status: 304, notModified: true }
    if (response.status === 403 || response.status === 429) {
      return { status: response.status, rateLimited: true, retryAfterMs: retryAfterMs(response) }
    }
    if (response.status === 404) return { status: 404 }
    if (!response.ok) return { status: response.status, transport: response.status >= 500 }
    const text = (await response.text()).slice(0, 200_000)
    if (text.trim() === '') return { status: response.status, empty: true }
    return {
      status: response.status,
      text,
      etag: response.headers?.get?.('etag') ?? null,
    }
  } catch (error) {
    const cause = error?.cause?.code ?? ''
    const timeout = error?.name === 'TimeoutError'
      || error?.name === 'AbortError'
      || String(cause).includes('TIMEOUT')
    return { network: true, timeout, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function fetchGithubReadme(target, {
  fetchImpl,
  limiter = null,
  sleep = defaultSleep,
  timeoutMs = README_REQUEST_TIMEOUT_MS,
  etag = null,
} = {}) {
  if (!target) return { status: 404 }
  const ref = String(target.ref)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  for (const filename of GITHUB_FILENAMES) {
    const url = `https://${GITHUB_HOST}/${target.owner}/${target.name}/${ref}/${filename}`
    const result = await requestText(url, { fetchImpl, limiter, sleep, timeoutMs, etag })
    if (result.status === 200 && typeof result.text === 'string') {
      return { ...result, url, source: 'github-raw', key: target.key }
    }
    if (result.notModified) return { ...result, url, source: 'github-raw', key: target.key }
    if (result.status === 404) continue
    // 403/429/network/5xx: stop the filename loop and report the outcome.
    return { ...result, url, source: 'github-raw', key: target.key }
  }
  return { status: 404, source: 'github-raw', key: target.key }
}

export async function fetchNpmReadme(pkg, version, {
  fetchImpl,
  limiter = null,
  sleep = defaultSleep,
  timeoutMs = README_REQUEST_TIMEOUT_MS,
  etag = null,
} = {}) {
  if (!pkg || !version) return { status: 404 }
  const key = `npm:${pkg}@${version}`
  let last = { status: 404 }
  for (const [provider, base] of NPM_PROVIDERS) {
    for (const filename of GITHUB_FILENAMES) {
      const url = `${base}/${pkg}@${version}/${filename}`
      const result = await requestText(url, { fetchImpl, limiter, sleep, timeoutMs, etag })
      if (result.status === 200 && typeof result.text === 'string') {
        return { ...result, url, source: 'npm-cdn', provider, key }
      }
      if (result.notModified) return { ...result, url, source: 'npm-cdn', provider, key }
      last = { ...result, source: 'npm-cdn', provider, key }
      if (result.status === 404) continue
      if (result.rateLimited) break
      if (result.transport || result.network) break
    }
  }
  return last
}
