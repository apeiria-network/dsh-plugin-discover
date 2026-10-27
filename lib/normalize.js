/**
 * Turn the two directory sources into one card per installable target.
 *
 * Identity keys (v2.7):
 * - `targetKey`: npm package name (version stripped) or `github:owner/repo`
 *   (ref stripped).
 * - `repoKey`: normalized repository URL, after following
 *   `repoHealth.renamedTo` to its final target.
 * - `titleKey`: the catalog `title` (upstream repository).
 *
 * Cards are unioned by those keys, then by near-identical descriptions within
 * one repository basename. Each group keeps one canonical card; merged members
 * are retained in `copies` for `explain` but never take part in retrieval.
 * Entries whose upstream repository is deleted are dropped.
 */
import { createHash } from 'node:crypto'

export const DSH_SO_URL = 'https://www.dsh.so/plugins-index.json'
export const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
export const ATTRIBUTION = 'Powered by dsh.so — DSH Developer Hub'

const NPM_TARGET_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._+-]*)?$/i
const GITHUB_TARGET_RE = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+(#([^\s;|&$`<>()*?\\]+))?$/iu
const INSTALL_RE = /^dsh\s+plugin\s+--profile\s+[a-z0-9._-]+\s+add\s+(.+)$/i
const GITHUB_TARGET_PARSE = /^github:([^/#]+)\/([^#]+?)(?:#(.+))?$/i
const GITHUB_URL_PARSE = /github\.com\/([^/]+)\/([^/#?]+)/i

const CLONE_MIN_DESCRIPTION = 60
const CLONE_MIN_SIMILARITY = 0.85
const RENAME_MAX_DEPTH = 8

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value, limit = 32) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim().toLowerCase()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    if (seen.size >= limit) break
  }
  return [...seen]
}

/** Normalize a repository URL so `git+https`, `.git`, case, and trailing slash compare equal. */
export function normalizeRepo(url) {
  if (typeof url !== 'string') return ''
  let value = url.trim().toLowerCase()
  value = value.replace(/^git\+/, '').replace(/^git@([^:]+):/, '$1/')
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.replace(/^www\./, '')
  value = value.split(/[?#]/)[0]
  value = value.replace(/\.git$/, '').replace(/\/+$/, '')
  return value
}

/** Whether a target is a plain npm name or a GitHub spec, never a shell fragment. */
export function isSafeInstallTarget(target) {
  if (typeof target !== 'string') return false
  const text = target.trim()
  if (text === '' || text.length > 200) return false
  return NPM_TARGET_RE.test(text) || GITHUB_TARGET_RE.test(text)
}

/** Parse the dsh.so `install` command into its exact target. */
export function parseInstallTarget(install) {
  if (typeof install !== 'string') return null
  const match = INSTALL_RE.exec(install.trim())
  if (!match) return null
  const target = match[1].trim()
  if (!isSafeInstallTarget(target)) return null
  return { target }
}

/** Package name inside an npm or GitHub target (version and ref removed). */
export function packageNameOf(target) {
  if (typeof target !== 'string') return ''
  if (target.toLowerCase().startsWith('github:')) return target.split('#')[0]
  if (target.startsWith('@')) {
    const slash = target.indexOf('/')
    if (slash === -1) return target
    const at = target.indexOf('@', slash)
    return at === -1 ? target : target.slice(0, at)
  }
  const at = target.indexOf('@')
  return at === -1 ? target : target.slice(0, at)
}

function latestCatalogVersion(entry) {
  const versions = Array.isArray(entry?.versions) ? entry.versions : []
  let best = null
  for (const version of versions) {
    if (!version || typeof version !== 'object') continue
    const time = asNumber(version.publishTimestamp) ?? -1
    if (!best || time > best.time) best = { value: version, time }
  }
  return best?.value ?? null
}

function catalogText(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    return asString(value.en) || asString(value.zh) || ''
  }
  return ''
}

function catalogTopics(entry) {
  const metadata = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}
  const values = []
  if (typeof metadata.category === 'string') values.push(metadata.category)
  if (Array.isArray(metadata.keywords)) values.push(...metadata.keywords)
  if (Array.isArray(metadata.labels)) values.push(...metadata.labels)
  return asStringArray(values, 16)
}

function fitsVerification(value) {
  if (!value || typeof value !== 'object') return null
  const level = asNumber(value.level)
  if (level === null || level < 1 || level > 5) return null
  return {
    level,
    label: asString(value.label) || `L${level}`,
    lastVerifiedAt: asString(value.lastVerifiedAt) || null,
  }
}

function fitsSecurity(value) {
  if (!value || typeof value !== 'object') return null
  const status = asString(value.status) || 'unknown'
  const riskLevel = asString(value.riskLevel) || 'unknown'
  const counts = value.counts && typeof value.counts === 'object'
    ? {
        critical: asNumber(value.counts.critical) ?? 0,
        warning: asNumber(value.counts.warning) ?? 0,
        info: asNumber(value.counts.info) ?? 0,
      }
    : null
  return {
    status,
    riskLevel,
    scannedAt: asString(value.scannedAt) || null,
    ...(counts ? { counts } : {}),
  }
}

function contentHash(record) {
  const payload = JSON.stringify([
    record.name,
    record.title ?? '',
    record.description ?? '',
    record.topics,
    record.capability,
    record.install?.target ?? '',
    record.repo ?? '',
  ])
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function baseRecord(record) {
  return {
    id: record.id,
    name: record.name,
    alias: record.alias ?? '',
    title: record.title ?? '',
    description: record.description ?? '',
    topics: record.topics ?? [],
    capability: record.capability ?? [],
    stars: record.stars ?? null,
    verification: record.verification ?? null,
    security: record.security ?? null,
    repo: record.repo ?? '',
    repoKey: record.repoKey ?? '',
    url: record.url ?? '',
    install: record.install ?? null,
    dshRange: record.dshRange ?? null,
    updatedAt: record.updatedAt ?? null,
    kind: record.kind ?? 'plugin',
    sources: record.sources ?? [],
    aliases: record.aliases ?? [],
    alternatives: [],
  }
}

/* ---------- identity helpers ---------- */

function githubTargetParts(target) {
  if (typeof target !== 'string') return null
  const match = GITHUB_TARGET_PARSE.exec(target.trim())
  if (!match) return null
  return {
    owner: match[1].toLowerCase(),
    name: match[2].toLowerCase().replace(/\.git$/, ''),
    ref: match[3] ?? '',
  }
}

function githubRepoOf(record) {
  const fromTarget = githubTargetParts(record?.install?.target)
  if (fromTarget) {
    return {
      owner: fromTarget.owner,
      name: fromTarget.name,
      full: `${fromTarget.owner}/${fromTarget.name}`,
    }
  }
  const match = GITHUB_URL_PARSE.exec(String(record?.repo ?? ''))
  if (!match) return null
  const owner = match[1].toLowerCase()
  const name = match[2].toLowerCase().replace(/\.git$/, '')
  return { owner, name, full: `${owner}/${name}` }
}

function targetKeyOf(target) {
  const github = githubTargetParts(target)
  if (github) return `gh:${github.owner}/${github.name}`
  const name = packageNameOf(target)
  return name ? `npm:${name.toLowerCase()}` : ''
}

function versionOf(target) {
  if (typeof target !== 'string') return ''
  const github = githubTargetParts(target)
  if (github) return github.ref
  if (target.startsWith('@')) {
    const slash = target.indexOf('/')
    const at = target.indexOf('@', slash + 1)
    return at > 0 ? target.slice(at + 1) : ''
  }
  const at = target.indexOf('@')
  return at > 0 ? target.slice(at + 1) : ''
}

function versionParts(value) {
  return String(value ?? '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite)
}

function compareVersions(a, b) {
  const left = versionParts(a)
  const right = versionParts(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? 0
    const y = right[index] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

function normalizeTitle(value) {
  return String(value ?? '').trim().toLowerCase().replace(/#.*$/, '').replace(/\.git$/, '')
}

function normalizeAlias(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^@/, '').replace(/\.git$/, '')
}

function nameBase(value) {
  return String(value ?? '').toLowerCase().split('/').pop()
}

function shingles(text) {
  const value = String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const set = new Set()
  for (let index = 0; index + 3 <= value.length; index += 1) set.add(value.slice(index, index + 3))
  return set
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/** Follow `repoHealth.renamedTo` to the final repository, guarding cycles. */
function resolveRepo(key, healthByRepo) {
  let current = key
  const seen = new Set()
  let depth = 0
  while (current && healthByRepo.has(current) && depth < RENAME_MAX_DEPTH && !seen.has(current)) {
    seen.add(current)
    const health = healthByRepo.get(current)
    const next = normalizeRepo(asString(health?.renamedTo))
    if (!next || next === current) break
    current = next
    depth += 1
  }
  return {
    key: current,
    repo: current ? `https://${current}` : '',
  }
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value !== ''))]
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim() !== ''))]
}

/** Union-find over entries; `union` reports whether two sets were joined. */
class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.rank = new Uint8Array(size)
  }

  find(value) {
    let root = value
    while (this.parent[root] !== root) root = this.parent[root]
    while (this.parent[value] !== value) {
      const next = this.parent[value]
      this.parent[value] = root
      value = next
    }
    return root
  }

  union(a, b) {
    const left = this.find(a)
    const right = this.find(b)
    if (left === right) return false
    if (this.rank[left] < this.rank[right]) {
      this.parent[left] = right
    } else if (this.rank[left] > this.rank[right]) {
      this.parent[right] = left
    } else {
      this.parent[right] = left
      this.rank[left] += 1
    }
    return true
  }
}

/** The latest npm target for one product inside a group. */
function latestInstallTarget(group, canonical) {
  const base = canonical.record.install?.target ?? ''
  if (!base || githubTargetParts(base)) return base
  const product = packageNameOf(base).toLowerCase()
  if (!product) return base
  let best = base
  let bestVersion = versionOf(base)
  for (const entry of group) {
    const target = entry.record.install?.target ?? ''
    if (!target || githubTargetParts(target)) continue
    if (packageNameOf(target).toLowerCase() !== product) continue
    const version = versionOf(target)
    if (version === '') return target
    if (bestVersion === '' || compareVersions(version, bestVersion) > 0) {
      best = target
      bestVersion = version
    }
  }
  return best
}

/* ---------- canonical selection ---------- */

function upstreamHit(entry, groupTitle) {
  if (!groupTitle) return false
  const github = githubRepoOf(entry.record)
  if (github && github.full === groupTitle) return true
  if (entry.repoKey === `github.com/${groupTitle}`) return true
  return (entry.record.aliases ?? []).some(alias => normalizeAlias(alias) === groupTitle)
}

function npmOfficial(entry, groupTitle) {
  const target = entry.record.install?.target ?? ''
  if (!target || githubTargetParts(target)) return false
  const name = packageNameOf(target).toLowerCase()
  if (!name || name.startsWith('@')) return false
  return groupTitle ? name === groupTitle.split('/').pop() : false
}

function canonicalComparator(groupTitle) {
  return (a, b) => {
    if (a.dead !== b.dead) return a.dead ? 1 : -1
    const aHit = upstreamHit(a, groupTitle)
    const bHit = upstreamHit(b, groupTitle)
    if (aHit !== bHit) return aHit ? -1 : 1
    const aOfficial = npmOfficial(a, groupTitle)
    const bOfficial = npmOfficial(b, groupTitle)
    if (aOfficial !== bOfficial) return aOfficial ? -1 : 1
    const aStars = a.record.stars ?? 0
    const bStars = b.record.stars ?? 0
    if (aStars !== bStars) return bStars - aStars
    const aLevel = a.record.verification?.level ?? 0
    const bLevel = b.record.verification?.level ?? 0
    if (aLevel !== bLevel) return bLevel - aLevel
    const aDsh = a.record.sources.includes('dsh.so') ? 1 : 0
    const bDsh = b.record.sources.includes('dsh.so') ? 1 : 0
    if (aDsh !== bDsh) return bDsh - aDsh
    const aTime = Date.parse(a.record.updatedAt ?? '') || 0
    const bTime = Date.parse(b.record.updatedAt ?? '') || 0
    if (aTime !== bTime) return bTime - aTime
    return String(a.record.id).localeCompare(String(b.record.id))
  }
}

/* ---------- build ---------- */

function sameUpstream(entry, canonical, groupTitle) {
  if (groupTitle) {
    if (entry.titleKey === groupTitle) return true
    if (entry.repoKey === `github.com/${groupTitle}`) return true
  }
  if (canonical.repoKey && entry.repoKey === canonical.repoKey) return true
  if (canonical.titleKey && entry.titleKey === canonical.titleKey) return true
  return false
}

function mergeGroup(group, groupTitle, canonical) {
  const live = group.filter(entry => !entry.dead)
  const merged = { ...canonical.record }
  merged.topics = unique(live.flatMap(entry => entry.record.topics ?? []))
  merged.capability = unique(live.flatMap(entry => entry.record.capability ?? []))
  const stars = live.map(entry => entry.record.stars).filter(value => typeof value === 'number' && Number.isFinite(value))
  merged.stars = stars.length > 0 ? Math.max(...stars) : null
  const times = live.map(entry => entry.record.updatedAt).filter(Boolean).sort()
  merged.updatedAt = times.at(-1) ?? merged.updatedAt ?? null
  merged.aliases = uniqueStrings(group.flatMap(entry => [
    entry.record.name,
    entry.record.alias,
    ...(entry.record.aliases ?? []),
  ]))
  merged.sources = unique(group.flatMap(entry => entry.record.sources ?? []))
  merged.title = merged.title || groupTitle
  if (!merged.repo && groupTitle) merged.repo = `https://github.com/${groupTitle}`
  if (!merged.repoKey && merged.repo) merged.repoKey = normalizeRepo(merged.repo)
  const dshRange = canonical.record.dshRange
    ?? group.find(entry => entry.record.dshRange)?.record.dshRange
    ?? null
  merged.dshRange = dshRange

  const target = latestInstallTarget(live, canonical)
  merged.install = target ? { target } : canonical.record.install

  const alternatives = []
  const copies = []
  for (const entry of group) {
    if (entry === canonical) continue
    const record = entry.record
    const copy = {
      id: record.id,
      name: record.name,
      target: record.install?.target ?? '',
      stars: record.stars ?? null,
      repo: record.repo ?? '',
      deleted: entry.dead === true,
    }
    const sameBaseName = nameBase(record.name) === nameBase(canonical.record.name)
    const sameTarget = entry.targetKey !== '' && entry.targetKey === canonical.targetKey
    const alternative = !sameBaseName && !sameTarget
      && sameUpstream(entry, canonical, groupTitle)
      && copy.target !== ''
      && record.name !== canonical.record.name
    if (alternative) alternatives.push({ name: record.name, target: copy.target })
    else copies.push(copy)
  }
  merged.alternatives = alternatives
  merged.copies = copies
  merged.contentHash = contentHash(merged)
  return merged
}

function assertDedupe(cards) {
  const targets = new Map()
  const upstreams = new Map()
  for (const card of cards) {
    const target = targetKeyOf(card.install?.target)
    if (target) {
      if (targets.has(target)) {
        throw new Error(`去重自检失败：安装目标 ${target} 出现在 ${targets.get(target)} 与 ${card.id}`)
      }
      targets.set(target, card.id)
    }
    const upstream = normalizeTitle(card.title) || card.repoKey
    if (upstream) {
      if (upstreams.has(upstream)) {
        throw new Error(`去重自检失败：上游 ${upstream} 出现在 ${upstreams.get(upstream)} 与 ${card.id}`)
      }
      upstreams.set(upstream, card.id)
    }
    if ((card.copies ?? []).some(copy => copy.id === card.id)) {
      throw new Error(`去重自检失败：${card.id} 出现在自己的 copies 中`)
    }
  }
}

/**
 * Build the card set.
 * @param {unknown} dshSo parsed dsh.so index
 * @param {unknown} catalog parsed format-1 catalog, or null when unavailable
 */
export function buildRecords(dshSo, catalog) {
  if (!dshSo || typeof dshSo !== 'object' || !Array.isArray(dshSo.plugins)) {
    throw new Error('dsh.so index is missing the plugins array')
  }
  const catalogPlugins = catalog && typeof catalog === 'object' && Array.isArray(catalog.plugins)
    ? catalog.plugins
    : []
  const catalogByRepo = new Map()
  const catalogByName = new Map()
  const catalogByProduct = new Map()
  const catalogByBase = new Map()
  const baseCounts = new Map()
  for (const entry of catalogPlugins) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue
    const repoKey = normalizeRepo(entry.repository?.url)
    if (repoKey && !catalogByRepo.has(repoKey)) catalogByRepo.set(repoKey, entry)
    const name = entry.name.trim().toLowerCase()
    if (name && !catalogByName.has(name)) catalogByName.set(name, entry)
    if (name && !catalogByProduct.has(name)) catalogByProduct.set(name, entry)
    const base = nameBase(name)
    if (base) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
  }
  for (const entry of catalogPlugins) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue
    const base = nameBase(entry.name)
    if (base && baseCounts.get(base) === 1) catalogByBase.set(base, entry)
  }

  const healthByRepo = new Map()
  for (const plugin of dshSo.plugins) {
    if (!plugin || typeof plugin !== 'object') continue
    const repoKey = normalizeRepo(asString(plugin.source))
    if (repoKey) healthByRepo.set(repoKey, plugin.repoHealth ?? null)
  }

  const usedCatalog = new Set()
  const entries = []
  let skippedNoInstall = 0
  let skippedBadInstall = 0
  let dshSoInstallable = 0

  for (const plugin of dshSo.plugins) {
    if (!plugin || typeof plugin !== 'object') continue
    const install = parseInstallTarget(plugin.install)
    if (plugin.install == null || String(plugin.install).trim() === '') {
      skippedNoInstall += 1
      continue
    }
    if (!install) {
      skippedBadInstall += 1
      continue
    }
    const alias = asString(plugin.alias)
    const name = asString(plugin.name) || alias || asString(plugin.id)
    if (name === '') continue
    const sourceRepo = asString(plugin.source)
    const targetRepo = githubTargetParts(install.target)
    const baseRepoKey = normalizeRepo(sourceRepo)
      || (targetRepo ? `github.com/${targetRepo.owner}/${targetRepo.name}` : '')
    const resolved = resolveRepo(baseRepoKey, healthByRepo)
    const repoKey = resolved.key
    const repo = sourceRepo || resolved.repo
    const product = packageNameOf(install.target).toLowerCase()
    const base = nameBase(name)
    const baseRepo = githubRepoOf({ install, repo: sourceRepo || resolved.repo })
    const baseEntry = name.startsWith('@') ? catalogByBase.get(base) : null
    const baseHit = baseEntry
      && nameBase(normalizeTitle(baseEntry.title)) === base
      && (!baseRepo || baseRepo.name === base)
      ? baseEntry
      : null
    const catalogEntry = catalogByRepo.get(repoKey)
      ?? catalogByName.get(alias.toLowerCase())
      ?? catalogByName.get(name.toLowerCase())
      ?? (product && !product.startsWith('github:') ? catalogByProduct.get(product) : null)
      ?? baseHit
    if (catalogEntry) usedCatalog.add(catalogEntry)

    const catalogVersion = catalogEntry ? latestCatalogVersion(catalogEntry) : null
    const engines = catalogVersion?.engines && typeof catalogVersion.engines === 'object'
      ? asString(catalogVersion.engines.dsh) : ''
    const publishedAt = asNumber(catalogVersion?.publishTimestamp)
    const title = catalogEntry ? asString(catalogEntry.title) : ''
    const record = baseRecord({
      id: asString(plugin.id) || name,
      name,
      alias,
      title,
      description: asString(plugin.description),
      topics: asStringArray(plugin.topics),
      capability: asStringArray(plugin.capability?.samples),
      stars: asNumber(plugin.stars) ?? 0,
      verification: fitsVerification(plugin.verification),
      security: fitsSecurity(plugin.security),
      repo,
      repoKey,
      url: asString(plugin.url) || asString(catalogEntry?.homepage) || repo,
      install,
      dshRange: engines || null,
      updatedAt: publishedAt && publishedAt > 0 ? new Date(publishedAt * 1000).toISOString() : null,
      kind: asString(plugin.kind) || 'plugin',
      sources: catalogEntry ? ['dsh.so', 'dsh-plugin-catalog'] : ['dsh.so'],
      aliases: uniqueStrings([name, alias]),
    })
    entries.push({
      record,
      dead: githubTargetParts(install.target) !== null && plugin.repoHealth?.status === 'deleted',
      targetKey: targetKeyOf(install.target),
      repoKey,
      titleKey: normalizeTitle(title),
    })
    dshSoInstallable += 1
  }

  for (const entry of catalogPlugins) {
    if (usedCatalog.has(entry)) continue
    if (!entry || typeof entry !== 'object') continue
    const name = asString(entry.name)
    if (!name) continue
    const repo = asString(entry.repository?.url)
    const repoKey = normalizeRepo(repo)
    const version = latestCatalogVersion(entry)
    const versionText = asString(version?.version)
    const target = versionText ? `${name}@${versionText}` : name
    if (!isSafeInstallTarget(target)) continue
    const engines = version?.engines && typeof version.engines === 'object' ? asString(version.engines.dsh) : ''
    const publishedAt = asNumber(version?.publishTimestamp)
    const title = asString(entry.title)
    const record = baseRecord({
      id: `catalog:${name}`,
      name,
      alias: name,
      title,
      description: catalogText(entry.description),
      topics: catalogTopics(entry),
      capability: [],
      stars: null,
      verification: null,
      security: null,
      repo,
      repoKey,
      url: asString(entry.homepage) || repo,
      install: { target },
      dshRange: engines || null,
      updatedAt: publishedAt && publishedAt > 0 ? new Date(publishedAt * 1000).toISOString() : null,
      kind: 'catalog',
      sources: ['dsh-plugin-catalog'],
      aliases: [name],
    })
    entries.push({
      record,
      dead: false,
      targetKey: targetKeyOf(target),
      repoKey,
      titleKey: normalizeTitle(title),
    })
  }

  const dsu = new DisjointSet(entries.length)
  const dedupe = {
    byTarget: 0,
    byRepo: 0,
    byTitle: 0,
    byClone: 0,
    droppedDeadGroups: 0,
    droppedDeadCards: 0,
    cardsBefore: entries.length,
    cardsAfter: 0,
  }
  const link = (map, key, index, reason) => {
    if (!key) return
    const previous = map.get(key)
    if (previous === undefined) {
      map.set(key, index)
      return
    }
    if (dsu.union(previous, index)) dedupe[reason] += 1
  }

  const targetIndex = new Map()
  const repoIndex = new Map()
  const titleIndex = new Map()
  entries.forEach((entry, index) => {
    link(targetIndex, entry.targetKey, index, 'byTarget')
    link(repoIndex, entry.repoKey, index, 'byRepo')
    link(titleIndex, entry.titleKey, index, 'byTitle')
  })

  // Clone clusters: same repository basename, near-identical description, and
  // no conflicting catalog upstream.
  const byBase = new Map()
  entries.forEach((entry, index) => {
    const github = githubRepoOf(entry.record)
    if (!github) return
    if (!byBase.has(github.name)) byBase.set(github.name, [])
    byBase.get(github.name).push({ index, entry, shingles: shingles(entry.record.description) })
  })
  for (const list of byBase.values()) {
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length; right += 1) {
        const a = list[left]
        const b = list[right]
        if (a.entry.titleKey && b.entry.titleKey && a.entry.titleKey !== b.entry.titleKey) continue
        const aLength = String(a.entry.record.description ?? '').length
        const bLength = String(b.entry.record.description ?? '').length
        if (aLength < CLONE_MIN_DESCRIPTION || bLength < CLONE_MIN_DESCRIPTION) continue
        if (similarity(a.shingles, b.shingles) < CLONE_MIN_SIMILARITY) continue
        if (dsu.union(a.index, b.index)) dedupe.byClone += 1
      }
    }
  }

  const groups = new Map()
  entries.forEach((entry, index) => {
    const root = dsu.find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(entry)
  })

  const cards = []
  const usedNames = new Map()
  let mergedCards = 0
  for (const group of groups.values()) {
    const live = group.filter(entry => !entry.dead)
    if (live.length === 0) {
      dedupe.droppedDeadGroups += 1
      dedupe.droppedDeadCards += group.length
      continue
    }
    const groupTitle = group.map(entry => entry.titleKey).find(Boolean) ?? ''
    live.sort(canonicalComparator(groupTitle))
    const canonical = live[0]
    if (group.length > 1) mergedCards += 1
    const merged = mergeGroup(group, groupTitle, canonical)

    if (usedNames.has(merged.id)) {
      const next = usedNames.get(merged.id) + 1
      usedNames.set(merged.id, next)
      merged.id = `${merged.id}#${next}`
    } else {
      usedNames.set(merged.id, 0)
    }
    cards.push(merged)
  }

  cards.sort((a, b) => a.id.localeCompare(b.id))
  assertDedupe(cards)

  const generatedAt = asString(dshSo.generatedAt) || asString(dshSo.generated) || null
  const catalogGeneratedAt = asString(catalog?.generatedAt) || asString(catalog?.metadata?.generatedAt) || null
  dedupe.cardsAfter = cards.length
  return {
    records: cards,
    stats: {
      dshSoTotal: dshSo.plugins.length,
      dshSoInstallable,
      skippedNoInstall,
      skippedBadInstall,
      catalogTotal: catalogPlugins.length,
      catalogMerged: usedCatalog.size,
      catalogOnly: cards.filter(record => record.sources.length === 1 && record.sources[0] === 'dsh-plugin-catalog').length,
      cards: cards.length,
      mergedCards,
      dedupe,
    },
    sources: {
      dshSo: {
        url: DSH_SO_URL,
        generatedAt,
        count: dshSo.plugins.length,
        ok: true,
      },
      catalog: {
        url: CATALOG_URL,
        generatedAt: catalogGeneratedAt,
        count: catalogPlugins.length,
        ok: catalogPlugins.length > 0,
      },
    },
  }
}
