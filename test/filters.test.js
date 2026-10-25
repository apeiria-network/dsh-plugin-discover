import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compatibilityAllowed, evaluateRecord, filterRecords, securityAllowed, selectFilter, verificationAllowed,
} from '../lib/filters.js'
import { qualityFactor } from '../lib/quality.js'
import { record, records } from './fixtures.js'

test('strict requires audited low and L5', () => {
  assert.equal(securityAllowed(record(), 'strict'), true)
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'medium' } }), 'strict'), false)
  assert.equal(securityAllowed(record({ security: null }), 'strict'), false)
  assert.equal(verificationAllowed(record(), 'strict'), true)
  assert.equal(verificationAllowed(record({ verification: { level: 4 } }), 'strict'), false)
})

test('balanced admits unaudited and unknown but rejects high or critical risk', () => {
  assert.equal(securityAllowed(record(), 'balanced'), true)
  assert.equal(securityAllowed(record({ security: { status: 'pending', riskLevel: 'unknown' } }), 'balanced'), true)
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'high' } }), 'balanced'), false)
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'critical' } }), 'balanced'), false)
  assert.equal(verificationAllowed(record({ verification: { level: 3 } }), 'balanced'), false)
  assert.equal(verificationAllowed(record({ verification: null }), 'balanced'), true)
})

test('loose excludes high/critical and off excludes only critical', () => {
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'high' } }), 'loose'), false)
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'high' } }), 'off'), true)
  assert.equal(securityAllowed(record({ security: { status: 'audited', riskLevel: 'critical' } }), 'off'), false)
})

test('compatibility unknown passes balanced and fails strict', () => {
  const unknown = record({ dshRange: null })
  assert.equal(compatibilityAllowed(unknown, 'balanced', '0.2.1'), true)
  assert.equal(compatibilityAllowed(unknown, 'strict', '0.2.1'), false)
  const incompatible = record({ dshRange: '>=0.1.0 <0.2.0' })
  assert.equal(compatibilityAllowed(incompatible, 'balanced', '0.2.1'), false)
})

test('filter records counts each drop reason', () => {
  const result = filterRecords(records, { preset: 'strict', runtimeVersion: '0.2.1' })
  assert.ok(result.droppedBy.security > 0)
  assert.ok(result.droppedBy.verification > 0)
  assert.ok(result.kept > 0)
})

test('a preset relaxes one step when fewer than three candidates survive', () => {
  const limited = [
    record(),
    record({ id: 'medium', name: 'medium', security: { status: 'audited', riskLevel: 'medium' } }),
    record({ id: 'pending', name: 'pending', security: { status: 'pending', riskLevel: 'unknown' } }),
  ]
  const result = selectFilter(limited, { preset: 'strict', runtimeVersion: '0.2.1' })
  assert.equal(result.relaxedFrom, 'strict')
  assert.equal(result.preset, 'balanced')
  assert.equal(result.kept, 3)
})

test('evaluateRecord reports the exact drop reason', () => {
  assert.deepEqual(evaluateRecord(record({ security: { status: 'audited', riskLevel: 'critical' } }), { preset: 'balanced' }), {
    ok: false,
    droppedBy: 'security',
  })
})

test('quality factor stays within the 20% bound', () => {
  for (const item of records) {
    const factor = qualityFactor(item, Date.parse('2026-10-22T00:00:00Z'))
    assert.ok(factor >= 0.8 && factor <= 1)
  }
})
