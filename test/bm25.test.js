import test from 'node:test'
import assert from 'node:assert/strict'
import { buildBm25, editDistance } from '../lib/bm25.js'
import { records } from './fixtures.js'

const index = buildBm25(records)

test('finds the WeCom notification plugin from English terms', () => {
  const hits = index.search(['wecom', 'webhook'])
  assert.ok(hits.length > 0)
  assert.equal(records[hits[0].doc].name, 'dsh-im-connect')
})

test('finds a Chinese sidebar plugin from Chinese bigrams', () => {
  const hits = index.search(['侧边', '边栏'])
  assert.ok(hits.length > 0)
  assert.equal(records[hits[0].doc].name, 'dsh-better-sidebar')
})

test('prefix and fuzzy expansion tolerate incomplete or misspelled terms', () => {
  const prefix = index.search(['notif'])
  assert.ok(prefix.some(hit => records[hit.doc].name === 'dsh-im-connect'))
  const fuzzy = index.search(['notificaton'])
  assert.ok(fuzzy.some(hit => records[hit.doc].name === 'dsh-im-connect'))
})

test('unrelated terms return nothing', () => {
  assert.deepEqual(index.search(['quantum', 'teleportation']), [])
})

test('minimum-hit filtering prevents a single common term from returning everything', () => {
  const hits = index.search(['webhook', 'quantum', 'teleportation', 'sidebar'])
  assert.ok(hits.every(hit => hit.matched >= 2))
})

test('edit distance exits early', () => {
  assert.equal(editDistance('notify', 'notify', 1), 0)
  assert.equal(editDistance('notify', 'notifx', 1), 1)
  assert.ok(editDistance('notify', 'zzzzzz', 1) > 1)
})
