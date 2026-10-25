/**
 * Index storage: the `current` pointer, manifests, the build lock, and
 * delayed cleanup of superseded index directories.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  buildLogPath, currentPath, isIndexDirName, lockPath, newIndexDirName, resolveIndexDir,
} from './paths.js'

/** A lock older than this is treated as abandoned even if its PID is alive. */
export const LOCK_STALE_MS = 30 * 60 * 1000

/** Directory names that look like published indexes, newest first. */
export function listIndexDirs(indexDir) {
  let names
  try {
    names = readdirSync(indexDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && isIndexDirName(entry.name))
      .map(entry => entry.name)
  } catch {
    return []
  }
  return names.sort((a, b) => b.localeCompare(a))
}

/** Read the `current` pointer; null when missing or malformed. */
export function readCurrent(indexDir) {
  try {
    const name = readFileSync(currentPath(indexDir), 'utf8').trim()
    if (!isIndexDirName(name)) return null
    const dir = resolveIndexDir(indexDir, name)
    if (!dir || !existsSync(join(dir, 'manifest.json')) || !existsSync(join(dir, 'records.json'))) return null
    return { name, dir, mtimeMs: statSync(currentPath(indexDir)).mtimeMs }
  } catch {
    return null
  }
}

/** Read the manifest behind the current pointer, if both are readable. */
export function readManifest(indexDir) {
  const current = readCurrent(indexDir)
  if (!current) return null
  try {
    const manifest = JSON.parse(readFileSync(join(current.dir, 'manifest.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object') return null
    return { ...current, manifest }
  } catch {
    return null
  }
}

/** Read the current record set; null when no usable index exists. */
export function readRecords(indexDir) {
  const current = readCurrent(indexDir)
  if (!current) return null
  try {
    const records = JSON.parse(readFileSync(join(current.dir, 'records.json'), 'utf8'))
    if (!Array.isArray(records)) return null
    return { ...current, records }
  } catch {
    return null
  }
}

/** Atomically point `current` at a published index directory. */
export function publishCurrent(indexDir, name) {
  if (!isIndexDirName(name)) throw new Error(`invalid index directory name: ${name}`)
  const target = currentPath(indexDir)
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, `${name}\n`)
  try {
    renameSync(temp, target)
  } catch (error) {
    // Windows can refuse to replace an existing file held open by a reader.
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST')) {
      try { unlinkSync(target) } catch {}
      renameSync(temp, target)
    } else {
      try { unlinkSync(temp) } catch {}
      throw error
    }
  }
}

/** Create a fresh unpublished index directory. */
export function createIndexDir(indexDir, now = new Date()) {
  mkdirSync(indexDir, { recursive: true })
  const name = newIndexDirName(now)
  const dir = join(indexDir, name)
  mkdirSync(dir, { recursive: true })
  return { name, dir }
}

/** Read the build lock; null when absent or unreadable. */
export function readLock(indexDir) {
  try {
    const value = JSON.parse(readFileSync(lockPath(indexDir), 'utf8'))
    if (!value || typeof value !== 'object') return null
    return value
  } catch {
    return null
  }
}

/** Whether a lock belongs to a dead or over-age builder. */
export function isLockStale(lock, now = Date.now()) {
  if (!lock || typeof lock !== 'object') return true
  if (typeof lock.startedAt !== 'number' || typeof lock.pid !== 'number') return true
  if (now - lock.startedAt > LOCK_STALE_MS) return true
  try {
    process.kill(lock.pid, 0)
    return false
  } catch (error) {
    return error && error.code === 'ESRCH'
  }
}

/**
 * Acquire the cross-process build lock. A stale lock is reclaimed once.
 * @returns `{ ok: true, release }` or `{ ok: false, lock }`.
 */
export function acquireLock(indexDir, { pid = process.pid, now = Date.now() } = {}) {
  mkdirSync(indexDir, { recursive: true })
  const file = lockPath(indexDir)
  const payload = JSON.stringify({ pid, startedAt: now, host: hostname() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, payload, { flag: 'wx' })
      return {
        ok: true,
        lock: { pid, startedAt: now, host: hostname() },
        release() {
          const held = readLock(indexDir)
          if (held && held.pid === pid && held.startedAt === now) {
            try { unlinkSync(file) } catch {}
          }
        },
      }
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      const existing = readLock(indexDir)
      if (existing && isLockStale(existing, now)) {
        try { unlinkSync(file) } catch {}
        continue
      }
      return { ok: false, lock: existing }
    }
  }
  return { ok: false, lock: readLock(indexDir) }
}

/** Remove index directories superseded by `keepName`, keeping the newest two. */
export function cleanupOldIndexes(indexDir, keepName, { now = Date.now(), maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const names = listIndexDirs(indexDir)
  const keep = new Set([keepName, ...names.filter(name => name !== keepName).slice(0, 1)])
  const removed = []
  for (const name of names) {
    if (keep.has(name)) continue
    const dir = join(indexDir, name)
    let age = 0
    try { age = now - statSync(dir).mtimeMs } catch { continue }
    if (age < maxAgeMs) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch {}
  }
  return removed
}

/** Read the tail of the build log, for diagnostics in tool output. */
export function readBuildLog(indexDir, maxChars = 4000) {
  try {
    const text = readFileSync(buildLogPath(indexDir), 'utf8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}
