/**
 * Host-side runtime: load the published index lazily, keep one searcher in
 * memory, and start background builds without blocking a session.
 */
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSearcher } from './search.js'
import { detectRuntimeVersion } from './compat.js'
import { buildIndex, isStale } from './build.js'
import { defaultIndexDir, buildLogPath } from './paths.js'
import {
  isLockStale, readBuildLog, readLock, readManifest, readRecords,
} from './store.js'

const WORKER = fileURLToPath(new URL('./build-worker.js', import.meta.url))

function readConfig(value) {
  return value && typeof value.get === 'function' ? value.get() : value
}

function resolveIndexDir(configured) {
  const value = readConfig(configured)
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? defaultIndexDir() : text
}

function nodeCommand() {
  if (process.env.DSH_PLUGIN_DISCOVER_NODE) return process.env.DSH_PLUGIN_DISCOVER_NODE
  return process.execPath
}

/** One runtime per plugin activation. */
export function createRuntime(config = {}) {
  let indexDir = resolveIndexDir(config.indexDir)
  let loaded = null
  let building = false
  let lastError = null
  let child = null
  let inProcess = false

  /** Apply a live indexDir override between calls, without restarting the Host. */
  function reconfigure(next = {}) {
    const nextDir = resolveIndexDir(next.indexDir)
    if (nextDir === indexDir || building) return
    indexDir = nextDir
    loaded = null
    lastError = null
  }

  function load() {
    const current = readManifest(indexDir)
    if (!current) return null
    if (loaded && loaded.name === current.name && loaded.mtimeMs === current.mtimeMs) return loaded
    const records = readRecords(indexDir)
    if (!records) return null
    loaded = {
      name: current.name,
      mtimeMs: current.mtimeMs,
      manifest: current.manifest,
      searcher: createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() }),
    }
    return loaded
  }

  function invalidate() {
    loaded = null
  }

  function activeLock() {
    const lock = readLock(indexDir)
    if (!lock) return null
    return isLockStale(lock) ? null : lock
  }

  function status() {
    const manifest = readManifest(indexDir)
    const lock = activeLock()
    return {
      indexDir,
      hasIndex: manifest !== null,
      manifest: manifest?.manifest ?? null,
      name: manifest?.name ?? null,
      building: building || lock !== null,
      lock,
      lastError,
    }
  }

  function finishBuild(error) {
    building = false
    child = null
    invalidate()
    if (error) lastError = error
  }

  function startInProcess() {
    if (inProcess) return
    inProcess = true
    building = true
    child = null
    const log = message => {
      try { appendFileSync(buildLogPath(indexDir), `[${new Date().toISOString()}] ${message}\n`) } catch {}
    }
    void buildIndex({ indexDir, onProgress: log })
      .then(() => finishBuild(null))
      .catch(error => finishBuild(error instanceof Error ? error.message : String(error)))
      .finally(() => { inProcess = false })
  }

  function kickBuild() {
    if (building) return { started: false, reason: 'running' }
    const lock = activeLock()
    if (lock) return { started: false, reason: 'locked', lock }
    building = true
    lastError = null
    try {
      const env = { ...process.env }
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
      child = spawn(nodeCommand(), [WORKER, indexDir], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      child.once('error', error => {
        lastError = `后台建库启动失败，改为主进程执行：${error.message}`
        startInProcess()
      })
      child.once('exit', code => {
        if (inProcess) return
        if (code && code !== 0) lastError = readBuildLog(indexDir).slice(-1200) || `建库进程退出码 ${code}`
        finishBuild(null)
      })
      child.unref()
      return { started: true }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      startInProcess()
      return { started: true, fallback: 'in-process' }
    }
  }

  function ensureIndex(policy = 'daily') {
    const current = load()
    if (current) {
      if (isStale(current.manifest, policy)) {
        const kick = kickBuild()
        return { current, building: kick.started || kick.reason === 'locked' || kick.reason === 'running', kick }
      }
      return { current, building: building || activeLock() !== null }
    }
    if (policy === 'off') return { current: null, building: false, kick: { started: false, reason: 'off' } }
    const kick = kickBuild()
    return { current: null, building: kick.started || kick.reason === 'locked' || kick.reason === 'running', kick }
  }

  function indexAgeMs() {
    const current = readManifest(indexDir)
    const builtAt = Date.parse(current?.manifest?.builtAt ?? '')
    return Number.isFinite(builtAt) ? Date.now() - builtAt : Number.POSITIVE_INFINITY
  }

  function isOlderThan(days) {
    return indexAgeMs() >= days * 86_400_000
  }

  async function waitForBuild() {
    if (!building && activeLock() === null) return
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (!building && activeLock() === null) {
          clearInterval(timer)
          resolve()
        }
      }, 200)
      timer.unref?.()
    })
  }

  /**
   * Blocking freshness gate for a user search. A stale/missing index must be
   * rebuilt before searching; the previous index is only a failure fallback.
   */
  async function ensureFresh(days = 7) {
    const current = load()
    if (current && !isOlderThan(days)) {
      return { current, stale: false, refreshed: false, fallback: false, error: null }
    }
    const previous = current
    kickBuild()
    await waitForBuild()
    const next = load()
    if (next && !isOlderThan(days)) {
      return { current: next, stale: true, refreshed: true, fallback: false, error: null }
    }
    if (previous) {
      return {
        current: previous,
        stale: true,
        refreshed: false,
        fallback: true,
        error: lastError || 'refresh did not produce a fresh index',
      }
    }
    return {
      current: null,
      stale: true,
      refreshed: false,
      fallback: false,
      error: lastError || 'refresh failed and no previous index exists',
    }
  }

  function dispose() {
    loaded = null
    if (child) {
      try { child.removeAllListeners() } catch {}
      child = null
    }
    building = false
  }

  return {
    get indexDir() { return indexDir },
    load,
    invalidate,
    status,
    kickBuild,
    ensureIndex,
    ensureFresh,
    waitForBuild,
    reconfigure,
    dispose,
  }
}

/** Coverage block for the tool value. */
export function coverageOf(manifest) {
  if (!manifest) return null
  const sources = manifest.sources ?? {}
  return {
    sources: sources.catalog?.ok ? ['dsh.so', 'dsh-plugin-catalog'] : ['dsh.so'],
    indexed: manifest.stats?.cards ?? 0,
    generatedAt: sources.dshSo?.generatedAt ?? manifest.generatedAt ?? null,
  }
}
