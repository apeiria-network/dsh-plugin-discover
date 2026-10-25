/**
 * Turn the two directory sources into one card per installable target.
 *
 * dsh.so wins every field it supplies; the catalog fills title, repository,
 * `engines.dsh`, publish time and npm versions. Ecosystem apps without an
 * install command are not installable targets and are left out.
 */
import { createHash } from 'node:crypto'
import { qualityPrior } from './quality.js'

export const DSH_SO_URL = 'https://www.dsh.so/plugins-index.json'
export const CATALOG_URL = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
export const ATTRIBUTION = 'Powered by dsh.so — DSH Developer Hub'

const NPM_TARGET_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9][a-z0-9._+-]*)?$/i
const GITHUB_TARGET_RE = /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+(#([^\s;|&$`<>()*?\\]+))?$/iu
const INSTALL_RE = /^dsh\s+plugin\s+--profile\s+[a-z0-9._-]+\s+add\s+(.+)$/i

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
  for (const entry of catalogPlugins) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue
    const repoKey = normalizeRepo(entry.repository?.url)
    if (repoKey && !catalogByRepo.has(repoKey)) catalogByRepo.set(repoKey, entry)
    const name = entry.name.trim().toLowerCase()
    if (name && !catalogByName.has(name)) catalogByName.set(name, entry)
  }

  const usedCatalog = new Set()
  const usedNames = new Map()
  const records = []
  let skippedNoInstall = 0
  let skippedBadInstall = 0

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
    const repo = asString(plugin.source)
    const repoKey = normalizeRepo(repo)
    const alias = asString(plugin.alias)
    const name = asString(plugin.name) || alias || asString(plugin.id)
    if (name === '') continue
    const catalogEntry = catalogByRepo.get(repoKey)
      ?? catalogByName.get(alias.toLowerCase())
      ?? catalogByName.get(name.toLowerCase())
    if (catalogEntry) usedCatalog.add(catalogEntry)

    const catalogVersion = catalogEntry ? latestCatalogVersion(catalogEntry) : null
    const engines = catalogVersion?.engines && typeof catalogVersion.engines === 'object'
      ? asString(catalogVersion.engines.dsh) : ''
    const publishedAt = asNumber(catalogVersion?.publishTimestamp)
    const record = baseRecord({
      id: asString(plugin.id) || name,
      name,
      alias,
      title: catalogEntry ? asString(catalogEntry.title) : '',
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
      aliases: [...new Set([name, alias].filter(Boolean))],
    })
    records.push(record)
  }

  const dshSoInstallable = records.length

  for (const entry of catalogPlugins) {
    if (usedCatalog.has(entry)) continue
    if (!entry || typeof entry !== 'object') continue
    const name = asString(entry.name)
    if (!name) continue
    const repo = asString(entry.repository?.url)
    const repoKey = normalizeRepo(repo)
    if (repoKey && catalogByRepo.has(repoKey) && usedCatalog.has(catalogByRepo.get(repoKey))) continue
    if (catalogByName.has(name.toLowerCase()) && usedCatalog.has(catalogByName.get(name.toLowerCase()))) continue
    const version = latestCatalogVersion(entry)
    const versionText = asString(version?.version)
    const target = versionText ? `${name}@${versionText}` : name
    if (!isSafeInstallTarget(target)) continue
    const engines = version?.engines && typeof version.engines === 'object' ? asString(version.engines.dsh) : ''
    const publishedAt = asNumber(version?.publishTimestamp)
    const record = baseRecord({
      id: `catalog:${name}`,
      name,
      alias: name,
      title: asString(entry.title),
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
    records.push(record)
  }

  const groups = new Map()
  for (const record of records) {
    const key = record.repoKey || `name:${record.name.toLowerCase()}`
    const group = groups.get(key)
    if (group) group.push(record)
    else groups.set(key, [record])
  }

  const cards = []
  let mergedCards = 0
  for (const group of groups.values()) {
    group.sort((a, b) => qualityPrior(b) - qualityPrior(a) || b.stars - a.stars)
    const main = group[0]
    if (group.length > 1) {
      mergedCards += 1
      main.alternatives = group.slice(1)
        .map(item => ({ name: item.name, target: item.install?.target ?? '' }))
        .filter(item => item.target !== '' && item.name !== main.name)
      main.topics = [...new Set(group.flatMap(item => item.topics))]
      main.capability = [...new Set(group.flatMap(item => item.capability))]
      main.aliases = [...new Set(group.flatMap(item => item.aliases))]
      const numericStars = group
        .map(item => item.stars)
        .filter(stars => typeof stars === 'number' && Number.isFinite(stars))
      main.stars = numericStars.length > 0 ? Math.max(...numericStars) : null
      const timestamps = group.map(item => item.updatedAt).filter(Boolean).sort()
      main.updatedAt = timestamps.at(-1) ?? main.updatedAt
      main.dshRange = main.dshRange ?? group.find(item => item.dshRange)?.dshRange ?? null
    }
    if (usedNames.has(main.id)) {
      const next = usedNames.get(main.id) + 1
      usedNames.set(main.id, next)
      main.id = `${main.id}#${next}`
    } else {
      usedNames.set(main.id, 0)
    }
    main.contentHash = contentHash(main)
    cards.push(main)
  }
  cards.sort((a, b) => a.id.localeCompare(b.id))

  const generatedAt = asString(dshSo.generatedAt) || asString(dshSo.generated) || null
  const catalogGeneratedAt = asString(catalog?.generatedAt) || asString(catalog?.metadata?.generatedAt) || null
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
