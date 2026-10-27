import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecords } from '../lib/normalize.js'
import { createSearcher, explain } from '../lib/search.js'

const NOW = '2026-10-27T00:00:00.000Z'

function plugin(overrides = {}) {
  return {
    id: 'p1',
    alias: 'p1',
    name: 'p1',
    description: 'A DSH plugin.',
    stars: 0,
    topics: [],
    install: 'dsh plugin --profile web add p1',
    source: '',
    verification: { level: 4 },
    security: { status: 'audited', riskLevel: 'low' },
    ...overrides,
  }
}

function catalogEntry(overrides = {}) {
  return {
    name: 'pkg',
    title: 'owner/pkg',
    description: { en: 'Catalog description' },
    repository: { url: 'https://github.com/owner/pkg' },
    versions: [{ version: '1.0.0', publishTimestamp: 1_792_456_800, source: { type: 'npm' }, engines: {} }],
    ...overrides,
  }
}

function build(plugins, catalog = null) {
  return buildRecords({ generatedAt: NOW, plugins }, catalog ? { format: 1, plugins: catalog } : null)
}

test('same install target merges and keeps the newest version', () => {
  const built = build([
    plugin({ id: 'a', alias: '@a/notify', name: 'notify', install: 'dsh plugin --profile web add notify@0.1.0', stars: 5 }),
    plugin({ id: 'b', alias: '@b/notify', name: 'notify', install: 'dsh plugin --profile web add notify@0.2.0', stars: 3 }),
  ])
  assert.equal(built.records.length, 1)
  const card = built.records[0]
  assert.equal(card.install.target, 'notify@0.2.0')
  assert.equal(card.copies.length, 1)
  assert.equal(card.copies[0].id, 'b')
  assert.equal(built.stats.dedupe.byTarget, 1)
})

test('catalog records merge into a dsh card by npm product even when names differ', () => {
  const built = build(
    [plugin({ id: 'x', alias: '@owner/x', name: '@owner/x', install: 'dsh plugin --profile web add x-pkg' })],
    [catalogEntry({ name: 'x-pkg', title: 'owner/x-pkg', repository: { url: 'https://github.com/owner/x-pkg' } })],
  )
  assert.equal(built.records.length, 1)
  const card = built.records[0]
  assert.equal(card.title, 'owner/x-pkg')
  assert.equal(card.repo, 'https://github.com/owner/x-pkg')
  assert.deepEqual([...card.sources].sort(), ['dsh-plugin-catalog', 'dsh.so'])
  assert.equal(built.stats.catalogOnly, 0)
  assert.equal(built.stats.catalogMerged, 1)
})

test('cards sharing a catalog title merge under the upstream card', () => {
  const built = build(
    [
      plugin({
        id: 'mobile-npm',
        alias: '@saya-ch/dsh-mobile',
        name: 'dsh-mobile',
        install: 'dsh plugin --profile web add dsh-mobile',
        stars: 603,
      }),
      plugin({
        id: 'mobile-fork',
        alias: '@fork/dsh-mobile',
        name: 'dsh-mobile',
        install: 'dsh plugin --profile web add github:fork/dsh-mobile#v1',
        source: 'https://github.com/fork/dsh-mobile',
        stars: 649,
      }),
    ],
    [catalogEntry({ name: 'dsh-mobile', title: 'saya-ch/dsh-mobile', repository: { url: 'https://github.com/saya-ch/dsh-mobile' } })],
  )
  assert.equal(built.records.length, 1)
  const card = built.records[0]
  assert.equal(card.id, 'mobile-npm')
  assert.equal(card.title, 'saya-ch/dsh-mobile')
  assert.equal(card.install.target, 'dsh-mobile')
  assert.equal(card.copies.length, 1)
  assert.equal(card.copies[0].id, 'mobile-fork')

  const searcher = createSearcher(built.records)
  const value = explain(searcher, 'mobile-fork')
  assert.equal(value.explain.found, true)
  assert.equal(value.explain.id, 'mobile-npm')
  assert.equal(value.explain.copies.length, 1)
})

test('near-identical descriptions under one repository basename merge into one card', () => {
  const description = 'Runtime evidence that helps agents trace, profile, and burn down hotspots across applications with detailed diagnostics and reports.'
  const built = build([
    plugin({
      id: 'flame-a',
      name: 'flameox',
      description,
      install: 'dsh plugin --profile web add github:alice/flameox#v1',
      source: 'https://github.com/alice/flameox',
    }),
    plugin({
      id: 'flame-b',
      name: 'flameox',
      description,
      install: 'dsh plugin --profile web add github:bob/flameox#v1',
      source: 'https://github.com/bob/flameox',
    }),
  ])
  assert.equal(built.records.length, 1)
  assert.equal(built.records[0].copies.length, 1)
  assert.equal(built.stats.dedupe.byClone, 1)
})

test('same basename with different descriptions stays separate', () => {
  const built = build([
    plugin({
      id: 'app-a',
      name: 'dsh-app',
      description: 'A community-maintained branded desktop client for DSH on Windows, macOS and Linux, with native window and tray support.',
      install: 'dsh plugin --profile web add github:alice/dsh-app#v1',
      source: 'https://github.com/alice/dsh-app',
    }),
    plugin({
      id: 'app-b',
      name: 'dsh-app',
      description: 'Unofficial DSH desktop app: a small Rust WebView2 shell that opens a native window without requiring a terminal.',
      install: 'dsh plugin --profile web add github:bob/dsh-app#v1',
      source: 'https://github.com/bob/dsh-app',
    }),
  ])
  assert.equal(built.records.length, 2)
})

test('a deleted upstream is dropped, and a dead copy is kept only as a copy', () => {
  const deleted = build([
    plugin({
      id: 'dead',
      install: 'dsh plugin --profile web add github:gone/x#v1',
      source: 'https://github.com/gone/x',
      repoHealth: { status: 'deleted' },
    }),
  ])
  assert.equal(deleted.records.length, 0)
  assert.equal(deleted.stats.dedupe.droppedDeadGroups, 1)

  const mixed = build([
    plugin({
      id: 'live',
      install: 'dsh plugin --profile web add github:acme/x#v2',
      source: 'https://github.com/acme/x',
      stars: 10,
    }),
    plugin({
      id: 'dead-copy',
      install: 'dsh plugin --profile web add github:acme/x#v1',
      source: 'https://github.com/acme/x',
      repoHealth: { status: 'deleted' },
    }),
  ])
  assert.equal(mixed.records.length, 1)
  assert.equal(mixed.records[0].copies.length, 1)
  assert.equal(mixed.records[0].copies[0].deleted, true)
})

test('repoHealth.renamedTo merges the old repository into the new one', () => {
  const built = build([
    plugin({
      id: 'old',
      install: 'dsh plugin --profile web add github:old/x#v1',
      source: 'https://github.com/old/x',
      stars: 10,
      repoHealth: { status: 'renamed', renamedTo: 'https://github.com/new/x' },
    }),
    plugin({
      id: 'new',
      install: 'dsh plugin --profile web add github:new/x#v2',
      source: 'https://github.com/new/x',
      stars: 5,
    }),
  ])
  assert.equal(built.records.length, 1)
  assert.equal(built.records[0].copies.length, 1)
  assert.equal(built.stats.dedupe.byRepo, 1)
})
