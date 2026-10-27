/**
 * Build one immutable index directory and publish it by switching `current`.
 * The build downloads only the two public directories, writes records and a
 * manifest, and never touches the previous published index.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  acquireLock, cleanupOldIndexes, createIndexDir, publishCurrent,
} from './store.js'
import { buildRecords, CATALOG_URL, DSH_SO_URL } from './normalize.js'
import { detectRuntimeVersion } from './compat.js'

const PACKAGE_VERSION = (() => {
  try {
    const file = fileURLToPath(new URL('../package.json', import.meta.url))
    return JSON.parse(readFileSync(file, 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

async function fetchJson(url, { timeoutMs = 120_000 } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': `dsh-plugin-discover/${PACKAGE_VERSION}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return await response.json()
}

function validateDshSo(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.plugins)) {
    throw new Error('dsh.so index has no plugins array')
  }
  if (typeof value.generatedAt !== 'string' && typeof value.generated !== 'string') {
    throw new Error('dsh.so index has no generatedAt')
  }
  return value
}

function validateCatalog(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.plugins)) return null
  if (value.format !== 1) return null
  return value
}

function writeText(path, content) {
  writeFileSync(path, content, 'utf8')
}

/**
 * Build the index.
 * @param {{ indexDir: string, onProgress?: (message: string) => void, now?: Date }} options
 */
export async function buildIndex({ indexDir, onProgress = () => {}, now = new Date() }) {
  mkdirSync(indexDir, { recursive: true })
  const lock = acquireLock(indexDir, { now: Date.now() })
  if (!lock.ok) {
    return {
      ok: false,
      busy: true,
      lock: lock.lock,
      message: '另一个建库进程正在运行',
    }
  }
  let created = null
  try {
    onProgress('[1/4] 下载 dsh.so 索引…')
    const dshSo = validateDshSo(await fetchJson(DSH_SO_URL, { timeoutMs: 180_000 }))
    onProgress(`[2/4] dsh.so ${dshSo.plugins.length} 条；下载 dsh-plugin-catalog…`)

    let catalog = null
    let catalogError = null
    try {
      catalog = validateCatalog(await fetchJson(CATALOG_URL, { timeoutMs: 90_000 }))
      if (!catalog) catalogError = 'catalog 格式不是 format 1'
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error)
    }
    if (catalogError) onProgress(`[2/4] catalog 不可用，继续用 dsh.so：${catalogError}`)

    onProgress('[3/4] 归一化、去重、合并…')
    const built = buildRecords(dshSo, catalog)
    created = createIndexDir(indexDir, now)
    const recordsFile = join(created.dir, 'records.json')
    writeText(recordsFile, JSON.stringify(built.records))
    const generatedAt = built.sources.dshSo.generatedAt
    const manifest = {
      format: 2,
      package: 'dsh-plugin-discover',
      version: PACKAGE_VERSION,
      builtAt: new Date().toISOString(),
      generatedAt,
      runtimeVersion: detectRuntimeVersion(),
      sources: built.sources,
      stats: built.stats,
      attribution: 'Powered by dsh.so — DSH Developer Hub',
      license: 'CC-BY-4.0 (index data)',
      catalogError,
    }
    writeText(join(created.dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    writeText(join(created.dir, 'README.txt'), [
      'dsh-plugin-discover local index',
      '',
      'Index data: dsh.so — DSH Developer Hub (https://www.dsh.so), CC-BY-4.0.',
      'Catalog data: dsh-plugin-catalog, CC0-1.0.',
      'Keep the generatedAt timestamp when redistributing the data.',
      'This directory contains no model weights and no executables.',
      '',
    ].join('\n'))
    onProgress(`[4/4] 写入 ${built.stats.cards} 张卡片，切换 current…`)
    publishCurrent(indexDir, created.name)
    const removed = cleanupOldIndexes(indexDir, created.name)
    onProgress(`完成：${built.stats.cards} 张卡片，数据截至 ${String(generatedAt).slice(0, 10)}`)
    return {
      ok: true,
      dir: created.dir,
      name: created.name,
      manifest,
      stats: built.stats,
      removed,
    }
  } catch (error) {
    if (created) {
      try { rmSync(created.dir, { recursive: true, force: true }) } catch {}
    }
    throw error
  } finally {
    lock.release()
  }
}

/** Freshness policy: whether an existing index should be refreshed automatically. */
export function isStale(manifest, policy = 'daily', now = Date.now()) {
  if (policy === 'off') return false
  if (!manifest) return policy !== 'off'
  const builtAt = Date.parse(manifest.builtAt ?? '')
  if (!Number.isFinite(builtAt)) return true
  const age = now - builtAt
  if (policy === 'manual') return false
  if (policy === 'weekly') return age > 7 * 86_400_000
  return age > 86_400_000
}
