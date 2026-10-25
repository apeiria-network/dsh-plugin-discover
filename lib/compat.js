/**
 * Minimal semantic-version comparison and DSH runtime detection. The catalog
 * stores ordinary npm ranges; anything this parser does not understand is
 * reported as `unknown`, which the balanced preset deliberately lets through.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a semantic version; null when malformed. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_RE.exec(value.trim())
  if (!match) return null
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some(part => part === '')) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Compare two semantic versions: <0, 0, or >0. Malformed input sorts first. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const compared = compareIdentifier(l, r)
    if (compared !== 0) return compared
  }
  return 0
}

function upperBound(version, kind) {
  const parsed = parseVersion(version)
  if (!parsed) return null
  const { major, minor, patch } = parsed
  if (kind === '^') {
    if (major > 0) return `${major + 1}.0.0-0`
    if (minor > 0) return `0.${minor + 1}.0-0`
    return `0.0.${patch + 1}-0`
  }
  if (kind === '~') return `${major}.${minor + 1}.0-0`
  return null
}

function satisfiesComparator(version, comparator) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator.trim())
  if (!match) return null
  const operator = match[1] ?? '='
  const target = match[2].trim()
  if (target === '' || target === '*' || target === 'x' || target === 'X') return true
  if (!parseVersion(target)) return null
  if (operator === '=') return compareVersions(version, target) === 0
  if (operator === '>') return compareVersions(version, target) > 0
  if (operator === '>=') return compareVersions(version, target) >= 0
  if (operator === '<') return compareVersions(version, target) < 0
  if (operator === '<=') return compareVersions(version, target) <= 0
  const upper = upperBound(target, operator)
  if (!upper) return null
  return compareVersions(version, target) >= 0 && compareVersions(version, upper) < 0
}

/**
 * Check a version against a range. Returns `true`, `false`, or `null` for a
 * range this parser does not understand.
 */
export function satisfiesRange(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string') return null
  if (!parseVersion(version)) return null
  const groups = range.split('||').map(group => group.trim()).filter(Boolean)
  if (groups.length === 0) return null
  let understood = false
  for (const group of groups) {
    const comparators = group.split(/\s+/).filter(Boolean)
    let all = true
    let anyUnknown = false
    for (const comparator of comparators) {
      const result = satisfiesComparator(version, comparator)
      if (result === null) { anyUnknown = true; all = false; break }
      understood = true
      if (!result) { all = false; break }
    }
    if (all && !anyUnknown) return true
  }
  return understood ? false : null
}

let detected

/** Guess the running DSH version without importing Host packages. */
export function detectRuntimeVersion() {
  if (detected !== undefined) return detected
  if (process.env.DSH_VERSION && parseVersion(process.env.DSH_VERSION)) {
    detected = process.env.DSH_VERSION
    return detected
  }
  const roots = new Set()
  const add = value => { if (typeof value === 'string' && value.trim() !== '') roots.add(value) }
  add(process.cwd())
  add(process.env.DSH_PROFILE_DIR)
  add(process.env.DSH_HOME)
  try { add(dirname(fileURLToPath(import.meta.url))) } catch {}
  const require = createRequire(import.meta.url)
  const manifests = [
    '@deepseek-ai/dsh-app-boot/package.json',
    '@deepseek-ai/dsh/package.json',
    '@deepseek-ai/dsh-cli/package.json',
  ]
  for (const root of roots) {
    for (const manifest of manifests) {
      try {
        const file = require.resolve(manifest, { paths: [root] })
        const value = JSON.parse(readFileSync(file, 'utf8'))
        if (value && parseVersion(value.version)) {
          detected = value.version
          return detected
        }
      } catch {}
    }
  }
  detected = null
  return detected
}

/** Reset the detection cache (tests only). */
export function resetRuntimeVersionCache() {
  detected = undefined
}
