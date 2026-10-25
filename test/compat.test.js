import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion, satisfiesRange } from '../lib/compat.js'

test('parses semantic versions including prereleases', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('v0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, prerelease: ['rc', '2'] })
  assert.equal(parseVersion('not-a-version'), null)
})

test('orders prereleases before releases', () => {
  assert.ok(compareVersions('0.2.1-rc.2', '0.2.1') < 0)
  assert.ok(compareVersions('0.2.1-rc.2', '0.2.1-rc.3') < 0)
  assert.ok(compareVersions('0.2.1-rc.10', '0.2.1-rc.2') > 0)
})

test('supports the caret, tilde, comparator, and OR forms used by the catalog', () => {
  assert.equal(satisfiesRange('0.2.1-rc.2', '^0.2.1-rc.2'), true)
  assert.equal(satisfiesRange('0.3.0', '^0.2.1-rc.2'), false)
  assert.equal(satisfiesRange('0.2.1', '~0.2.1'), true)
  assert.equal(satisfiesRange('0.2.1-rc.2', '>=0.1.6-alpha.2 <0.2.0 || >=0.2.0-0 <0.3.0-0'), true)
  assert.equal(satisfiesRange('0.1.0', '>=0.1.6-alpha.2 <0.2.0'), false)
})

test('unknown ranges report unknown rather than false', () => {
  assert.equal(satisfiesRange('0.2.1', 'latest'), null)
  assert.equal(satisfiesRange('0.2.1', ''), null)
})
