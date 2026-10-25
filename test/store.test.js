import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock, cleanupOldIndexes, createIndexDir, listIndexDirs, publishCurrent,
  readCurrent, readManifest, readRecords,
} from '../lib/store.js'
import { isStale } from '../lib/build.js'
import { coverageOf, createRuntime } from '../lib/runtime.js'

async function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-test-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function publish(dir, name, manifest) {
  const target = join(dir, name)
  mkdirSync(target)
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(target, 'records.json'), JSON.stringify([{ id: 'x', name: 'x' }]))
  publishCurrent(dir, name)
}

test('the lock is exclusive and releasable', () => withDir(dir => {
  const first = acquireLock(dir)
  assert.equal(first.ok, true)
  const second = acquireLock(dir)
  assert.equal(second.ok, false)
  first.release()
  const third = acquireLock(dir)
  assert.equal(third.ok, true)
  third.release()
}))

test('publishing switches the pointer and reads back', () => withDir(dir => {
  const created = createIndexDir(dir, new Date('2026-10-22T12:00:00Z'))
  const manifest = { format: 1, builtAt: '2026-10-22T12:00:00Z', stats: { cards: 1 }, sources: { dshSo: { generatedAt: '2026-10-22T00:00:00Z' } } }
  writeFileSync(join(created.dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(created.dir, 'records.json'), JSON.stringify([{ id: 'x', name: 'x' }]))
  publishCurrent(dir, created.name)
  assert.equal(readCurrent(dir).name, created.name)
  assert.equal(readManifest(dir).manifest.stats.cards, 1)
  assert.equal(readRecords(dir).records.length, 1)
  assert.equal(coverageOf(readManifest(dir).manifest).indexed, 1)
}))

test('cleanup removes only superseded, over-age directories', () => withDir(dir => {
  publish(dir, 'index-20260101T000000Z', { format: 1, builtAt: '2026-01-01T00:00:00Z' })
  publish(dir, 'index-20260102T000000Z', { format: 1, builtAt: '2026-01-02T00:00:00Z' })
  publish(dir, 'index-20260103T000000Z', { format: 1, builtAt: '2026-01-03T00:00:00Z' })
  const old = join(dir, 'index-20260101T000000Z')
  const tenDaysAgo = Date.now() - 10 * 86_400_000
  utimesSync(old, tenDaysAgo / 1000, tenDaysAgo / 1000)
  const removed = cleanupOldIndexes(dir, 'index-20260103T000000Z', { now: Date.now() })
  assert.ok(!listIndexDirs(dir).includes('index-20260101T000000Z'))
  assert.equal(removed.length, 1)
}))

test('freshness policies follow the documented windows', () => {
  const now = Date.parse('2026-10-22T00:00:00Z')
  const fresh = { builtAt: '2026-10-21T12:00:00Z' }
  const dayOld = { builtAt: '2026-10-20T00:00:00Z' }
  const weekOld = { builtAt: '2026-10-10T00:00:00Z' }
  const fiveDaysOld = { builtAt: '2026-10-17T00:00:00Z' }
  assert.equal(isStale(fresh, 'daily', now), false)
  assert.equal(isStale(dayOld, 'daily', now), true)
  assert.equal(isStale(fiveDaysOld, 'weekly', now), false)
  assert.equal(isStale(weekOld, 'weekly', now), true)
  assert.equal(isStale(weekOld, 'manual', now), false)
  assert.equal(isStale(weekOld, 'off', now), false)
})

test('runtime with no index and policy off does not build', () => withDir(async dir => {
  const runtime = createRuntime({ indexDir: dir, refreshPolicy: 'off' })
  const state = runtime.ensureIndex('off')
  assert.equal(state.current, null)
  assert.equal(state.building, false)
  assert.equal(state.kick.reason, 'off')
  assert.equal(runtime.status().hasIndex, false)
  runtime.dispose()
}))
