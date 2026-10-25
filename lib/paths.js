/**
 * Where the shared, per-user index lives. The directory name is a stable
 * identifier: it never follows a package rename and is shared by every DSH
 * profile of the same OS user.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Absolute default index directory for the current platform. */
export function defaultIndexDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-plugin-discover')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'dsh-plugin-discover')
  }
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'dsh-plugin-discover')
}

/** The pointer file naming the published index directory. */
export function currentPath(indexDir) {
  return join(indexDir, 'current')
}

/** The cross-process build lock. */
export function lockPath(indexDir) {
  return join(indexDir, 'build.lock')
}

/** Human-readable build log written by the child process. */
export function buildLogPath(indexDir) {
  return join(indexDir, 'build.log')
}

/** Reject any pointer value that would escape the index directory. */
export function isIndexDirName(name) {
  return typeof name === 'string' && /^index-[0-9A-Za-zT._-]+$/.test(name)
}

/** Resolve an index directory name below its parent. */
export function resolveIndexDir(indexDir, name) {
  if (!isIndexDirName(name)) return null
  return join(indexDir, name)
}

/** New sortable directory name, e.g. `index-20261022T120000000Z`. */
export function newIndexDirName(now = new Date()) {
  return `index-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`
}
