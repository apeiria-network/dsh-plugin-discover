import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../lib/runtime.js'
import { textReport } from '../lib/report.js'

const DAY = 86_400_000

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-discover-refresh-'))
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function writeIndex(dir, name, builtAt) {
  const target = join(dir, name)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'manifest.json'), JSON.stringify({
    builtAt: new Date(builtAt).toISOString(),
    generatedAt: '2026-10-20T00:00:00.000Z',
    sources: {},
    stats: {},
  }))
  writeFileSync(join(target, 'records.json'), '[]')
  writeFileSync(join(dir, 'current'), `${name}\n`)
}

/** Simulate an in-flight build owned by another process. */
function holdLock(dir) {
  writeFileSync(join(dir, 'build.lock'), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    host: 'test',
  }))
}

function releaseLock(dir) {
  rmSync(join(dir, 'build.lock'), { force: true })
}

async function waitTick(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

test('fresh index is returned without starting a build', () => withDir(async dir => {
  writeIndex(dir, 'index-a', Date.now() - 2 * DAY)
  const runtime = createRuntime({ indexDir: dir })
  const state = await runtime.ensureFresh(7)
  assert.equal(state.stale, false)
  assert.equal(state.refreshed, false)
  assert.equal(state.fallback, false)
  assert.equal(state.current?.name, 'index-a')
}))

test('stale search waits for an external rebuild before using the new index', () => withDir(async dir => {
  writeIndex(dir, 'index-old', Date.now() - 8 * DAY)
  holdLock(dir)
  const runtime = createRuntime({ indexDir: dir })
  const pending = runtime.ensureFresh(7)
  await waitTick()
  writeIndex(dir, 'index-new', Date.now())
  releaseLock(dir)
  const state = await pending
  assert.equal(state.stale, true)
  assert.equal(state.refreshed, true)
  assert.equal(state.fallback, false)
  assert.equal(state.current?.name, 'index-new')
}))

test('failed external rebuild falls back to the previous index', () => withDir(async dir => {
  writeIndex(dir, 'index-old', Date.now() - 8 * DAY)
  holdLock(dir)
  const runtime = createRuntime({ indexDir: dir })
  const pending = runtime.ensureFresh(7)
  await waitTick()
  releaseLock(dir)
  const state = await pending
  assert.equal(state.stale, true)
  assert.equal(state.refreshed, false)
  assert.equal(state.fallback, true)
  assert.equal(state.current?.name, 'index-old')
  assert.match(state.error, /did not produce a fresh index/)
}))

test('failed rebuild with no previous index returns no current index', () => withDir(async dir => {
  holdLock(dir)
  const runtime = createRuntime({ indexDir: dir })
  const pending = runtime.ensureFresh(7)
  await waitTick()
  releaseLock(dir)
  const state = await pending
  assert.equal(state.current, null)
  assert.equal(state.refreshed, false)
  assert.equal(state.fallback, false)
  assert.match(state.error, /no previous index exists/)
}))

test('concurrent searches wait on the same external rebuild', () => withDir(async dir => {
  writeIndex(dir, 'index-old', Date.now() - 8 * DAY)
  holdLock(dir)
  const runtime = createRuntime({ indexDir: dir })
  const first = runtime.ensureFresh(7)
  const second = runtime.ensureFresh(7)
  await waitTick()
  writeIndex(dir, 'index-new', Date.now())
  releaseLock(dir)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.current?.name, 'index-new')
  assert.equal(b.current?.name, 'index-new')
  assert.equal(a.refreshed, true)
  assert.equal(b.refreshed, true)
}))

test('day/week/month/quarter freshness boundaries accept the selected days', () => withDir(async dir => {
  for (const days of [1, 7, 30, 90]) {
    writeIndex(dir, `index-fresh-${days}`, Date.now() - (days - 0.5) * DAY)
    const runtime = createRuntime({ indexDir: dir })
    const state = await runtime.ensureFresh(days)
    assert.equal(state.stale, false, `${days}-day boundary should be fresh`)
    assert.equal(state.current?.name, `index-fresh-${days}`)
  }
}))

test('report prepends the English index notice', () => {
  const report = textReport({
    results: [{
      name: 'dsh-test',
      description: 'test',
      install: { target: 'dsh-test' },
      badges: {},
    }],
    interpreted: {},
    filterStats: {},
    index: {
      notice: 'The plugin index refresh failed: HTTP 503. Results use the previous index; they may be stale.',
    },
  }, {})
  assert.ok(report.startsWith('⚠️ '))
  assert.match(report, /HTTP 503/)
})
