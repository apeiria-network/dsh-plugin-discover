/**
 * The quality prior. It may only lower a result by 20%: relevance stays the
 * primary key, and stars can never silently become the sort key.
 */

const VERIFICATION_SCORE = { 5: 1, 4: 0.8, 3: 0.6, 2: 0.45, 1: 0.3 }

/** Verification level as a 0..1 signal; missing is neutral. */
export function verificationScore(record) {
  const level = record?.verification?.level
  return VERIFICATION_SCORE[level] ?? 0.5
}

/** Security status/risk as a 0..1 signal; missing and pending are neutral. */
export function securityScore(record) {
  const security = record?.security
  if (!security || typeof security !== 'object') return 0.5
  const status = security.status
  const risk = security.riskLevel
  if (status === 'failed') return 0.2
  if (status === 'audited') {
    if (risk === 'low') return 1
    if (risk === 'medium') return 0.7
    if (risk === 'high') return 0.25
    if (risk === 'critical') return 0
    return 0.5
  }
  if (status === 'pending') return 0.45
  return 0.4
}

/** Popularity from stars, capped at 1000; unknown stars are neutral. */
export function popularityScore(record) {
  const stars = record?.stars
  if (typeof stars !== 'number' || !Number.isFinite(stars)) return 0.5
  if (stars <= 0) return 0
  return Math.min(1, Math.log1p(stars) / Math.log1p(1000))
}

/** Recency with a 90-day half-life; missing timestamps are neutral. */
export function recencyScore(record, now = Date.now()) {
  const updatedAt = record?.updatedAt
  if (!updatedAt) return 0.5
  const time = Date.parse(updatedAt)
  if (!Number.isFinite(time)) return 0.5
  const ageDays = Math.max(0, (now - time) / 86_400_000)
  return 0.5 ** (ageDays / 90)
}

/** Combined quality prior in 0..1. */
export function qualityPrior(record, now = Date.now()) {
  return 0.55 * verificationScore(record)
    + 0.20 * securityScore(record)
    + 0.15 * popularityScore(record)
    + 0.10 * recencyScore(record, now)
}

/** The bounded multiplier applied to a relevance score. */
export function qualityFactor(record, now = Date.now()) {
  return 0.8 + 0.2 * qualityPrior(record, now)
}
