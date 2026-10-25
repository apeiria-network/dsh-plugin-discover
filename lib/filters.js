/**
 * Hard filtering by security, verification, and DSH compatibility. Missing
 * fields are "unknown", not "failed": they pass and stay annotated.
 */
import { satisfiesRange } from './compat.js'

export const PRESETS = ['strict', 'balanced', 'loose', 'off']
export const DEFAULT_PRESET = 'balanced'

function isAudited(record) {
  return record?.security?.status === 'audited'
}

function riskOf(record) {
  return record?.security?.riskLevel ?? 'unknown'
}

/** Security gate for one preset. Unknown security never fails a preset. */
export function securityAllowed(record, preset) {
  if (preset === 'strict') return isAudited(record) && riskOf(record) === 'low'
  if (preset === 'off') return !(isAudited(record) && riskOf(record) === 'critical')
  if (preset === 'loose') {
    const risk = riskOf(record)
    return !(isAudited(record) && (risk === 'high' || risk === 'critical'))
  }
  if (!isAudited(record)) return true
  const risk = riskOf(record)
  return risk !== 'high' && risk !== 'critical'
}

/** Verification gate. `0` disables the level floor for the balanced preset. */
export function verificationAllowed(record, preset, minVerificationLevel = 4) {
  if (preset === 'strict') return record?.verification?.level === 5
  if (preset !== 'balanced') return true
  const minimum = Number.isFinite(minVerificationLevel) ? minVerificationLevel : 4
  if (minimum <= 0) return true
  const level = record?.verification?.level
  return typeof level !== 'number' ? true : level >= minimum
}

/** Compatibility state: true, false, or null for unknown. */
export function compatibilityOf(record, runtimeVersion) {
  const range = record?.dshRange
  if (typeof range !== 'string' || range.trim() === '') return null
  if (typeof runtimeVersion !== 'string' || runtimeVersion === '') return null
  return satisfiesRange(runtimeVersion, range)
}

/** Compatibility gate: balanced admits unknown, strict does not. */
export function compatibilityAllowed(record, preset, runtimeVersion) {
  if (preset === 'strict') return compatibilityOf(record, runtimeVersion) === true
  if (preset === 'loose' || preset === 'off') return true
  return compatibilityOf(record, runtimeVersion) !== false
}

/** Evaluate one record against one preset. */
export function evaluateRecord(record, { preset = DEFAULT_PRESET, minVerificationLevel = 4, runtimeVersion = null } = {}) {
  if (!securityAllowed(record, preset)) return { ok: false, droppedBy: 'security' }
  if (!verificationAllowed(record, preset, minVerificationLevel)) return { ok: false, droppedBy: 'verification' }
  if (!compatibilityAllowed(record, preset, runtimeVersion)) return { ok: false, droppedBy: 'compat' }
  return { ok: true }
}

/** Apply one preset to every record. */
export function filterRecords(records, options = {}) {
  const { preset = DEFAULT_PRESET, minVerificationLevel = 4, runtimeVersion = null } = options
  const allowed = new Uint8Array(records.length)
  const droppedBy = { security: 0, compatibility: 0, verification: 0 }
  let kept = 0
  for (let index = 0; index < records.length; index += 1) {
    const result = evaluateRecord(records[index], { preset, minVerificationLevel, runtimeVersion })
    if (result.ok) {
      allowed[index] = 1
      kept += 1
    } else if (result.droppedBy === 'compat') {
      droppedBy.compatibility += 1
    } else {
      droppedBy[result.droppedBy] += 1
    }
  }
  return { allowed, kept, droppedBy }
}

/**
 * Apply the requested preset, relaxing one step at a time until at least three
 * candidates survive. The caller reports `relaxedFrom` when this happens.
 */
export function selectFilter(records, options = {}) {
  const { preset = DEFAULT_PRESET, minVerificationLevel = 4, runtimeVersion = null, minCandidates = 3 } = options
  const start = PRESETS.includes(preset) ? preset : DEFAULT_PRESET
  const startIndex = PRESETS.indexOf(start)
  for (let index = startIndex; index < PRESETS.length; index += 1) {
    const candidate = PRESETS[index]
    const result = filterRecords(records, { preset: candidate, minVerificationLevel, runtimeVersion })
    if (result.kept >= minCandidates || candidate === 'off') {
      return {
        preset: candidate,
        relaxedFrom: candidate === start ? null : start,
        ...result,
      }
    }
  }
  const fallback = filterRecords(records, { preset: 'off', minVerificationLevel, runtimeVersion })
  return { preset: 'off', relaxedFrom: start, ...fallback }
}
