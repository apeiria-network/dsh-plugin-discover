import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRecords, normalizeRepo, packageNameOf, parseInstallTarget } from '../lib/normalize.js'

const dshSo = {
  generatedAt: '2026-10-22T00:00:00.000Z',
  plugins: [
    {
      id: 'im-connect',
      alias: 'dsh-im-connect',
      name: 'dsh-im-connect',
      description: 'Notifies via WeCom webhook when a turn ends.',
      stars: 751,
      topics: ['notification'],
      capability: { declaredCount: 2, samples: ['notification', 'wecom'] },
      install: 'dsh plugin --profile web add dsh-im-connect',
      source: 'https://github.com/acme/im-connect',
      url: 'https://www.dsh.so/artifact/im-connect/',
      verification: { level: 5, label: 'L5 · Run tested', lastVerifiedAt: '2026-10-18T00:00:00Z' },
      security: { status: 'audited', riskLevel: 'low', counts: { critical: 0, warning: 1, info: 0 } },
      kind: 'plugin',
    },
    {
      id: 'im-connect-cli',
      alias: '@acme/im-connect-cli',
      name: 'im-connect-cli',
      description: 'CLI companion for im-connect.',
      stars: 10,
      topics: [],
      install: 'dsh plugin --profile web add @acme/im-connect-cli@0.2.0',
      source: 'https://github.com/acme/im-connect',
      verification: { level: 4 },
      security: { status: 'audited', riskLevel: 'low' },
    },
    {
      id: 'desktop-app',
      alias: 'desktop-app',
      name: 'desktop-app',
      description: 'An ecosystem app.',
      stars: 100,
      topics: [],
      install: null,
      kind: 'ecosystem-app',
    },
    {
      id: 'bad',
      alias: 'bad',
      name: 'bad',
      description: 'Bad install string',
      stars: 0,
      topics: [],
      install: 'rm -rf /',
    },
  ],
}

const catalog = {
  format: 1,
  plugins: [
    {
      name: 'dsh-im-connect',
      title: 'acme/im-connect',
      description: { en: 'Catalog English description', zh: '目录中文描述' },
      repository: { url: 'https://github.com/acme/im-connect' },
      metadata: { category: 'notify', keywords: ['webhook'] },
      versions: [{ version: '0.4.2', publishTimestamp: 1_792_456_800, source: { type: 'npm' }, engines: { dsh: '>=0.2.0 <0.3.0-0' } }],
    },
    {
      name: 'dsh-catalog-only',
      title: 'someone/catalog-only',
      description: { en: 'Only in the catalog', zh: '只在目录里' },
      repository: { url: 'https://github.com/someone/catalog-only' },
      metadata: { category: 'memory', keywords: ['memory'] },
      versions: [{ version: '1.0.0', publishTimestamp: 1_792_456_800, source: { type: 'npm' }, engines: {} }],
    },
  ],
}

test('parses install commands and package names', () => {
  assert.deepEqual(parseInstallTarget('dsh plugin --profile web add @acme/x@1.2.3'), { target: '@acme/x@1.2.3' })
  assert.equal(parseInstallTarget('pnpm add x'), null)
  assert.equal(packageNameOf('@acme/x@1.2.3'), '@acme/x')
  assert.equal(packageNameOf('github:owner/repo#v1'), 'github:owner/repo')
})

test('normalizes repository URLs', () => {
  assert.equal(normalizeRepo('git+https://github.com/Acme/Im-Connect.git'), 'github.com/acme/im-connect')
  assert.equal(normalizeRepo('git@github.com:acme/im-connect.git'), 'github.com/acme/im-connect')
})

test('builds one card per installable target and fills catalog fields', () => {
  const built = buildRecords(dshSo, catalog)
  assert.equal(built.stats.skippedNoInstall, 1)
  assert.equal(built.stats.skippedBadInstall, 1)
  assert.equal(built.records.length, 2)
  const main = built.records.find(record => record.name === 'dsh-im-connect')
  assert.equal(main.title, 'acme/im-connect')
  assert.equal(main.dshRange, '>=0.2.0 <0.3.0-0')
  assert.equal(main.capability.includes('wecom'), true)
  assert.deepEqual(main.sources, ['dsh.so', 'dsh-plugin-catalog'])
  assert.equal(main.alternatives[0].name, 'im-connect-cli')
  assert.ok(main.updatedAt)
  const catalogOnly = built.records.find(record => record.name === 'dsh-catalog-only')
  assert.deepEqual(catalogOnly.sources, ['dsh-plugin-catalog'])
  assert.equal(catalogOnly.install.target, 'dsh-catalog-only@1.0.0')
  assert.equal(catalogOnly.stars, null)
})
