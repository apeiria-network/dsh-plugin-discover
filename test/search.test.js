import test from 'node:test'
import assert from 'node:assert/strict'
import { createSearcher, evaluateGate1, explain, search, NOISE_FILTER_LEVELS } from '../lib/search.js'
import { textReport } from '../lib/report.js'
import { vectorRerank } from '../lib/vector.js'
import { record, records } from './fixtures.js'

const searcher = createSearcher(records, { runtimeVersion: '0.2.1' })

test('a Chinese query with an English rewrite finds the right plugin', async () => {
  const value = await search(searcher, {
    query: '任务完成时给我发微信通知',
    queryAlts: [
      'notify on WeCom when a turn ends',
      'wecom webhook notification turn end',
      'send a message after the agent finishes',
    ],
    preset: 'balanced',
  })
  assert.equal(value.noMatch, false)
  assert.equal(value.results[0].name, 'dsh-im-connect')
  assert.equal(value.results[0].install.target, 'dsh-im-connect')
  assert.ok(value.filterStats.droppedBy.security > 0)
  assert.equal(value.interpreted.filters.preset, 'balanced')
  assert.equal(value.gates.level, 'medium')
  assert.equal(value.gates.gate1.enabled, true)
})

test('result limit is independent from the 50-candidate default and caps at 20', async () => {
  const many = Array.from({ length: 25 }, (_, index) => record({
    id: `dsh-bulk-${index}`,
    name: `dsh-bulk-${index}`,
    alias: `dsh-bulk-${index}`,
    description: `plugin bulk result ${index}`,
    topics: ['plugin'],
    capability: ['plugin'],
    repo: `https://github.com/acme/bulk-${index}`,
    repoKey: `github.com/acme/bulk-${index}`,
    install: { target: `dsh-bulk-${index}` },
    stars: 100 + index,
  }))
  const bulk = createSearcher(many, { runtimeVersion: '0.2.1' })
  const value = await search(bulk, {
    query: 'bulk',
    queryAlts: ['bulk'],
    limit: 50,
    preset: 'balanced',
  })
  assert.equal(value.results.length, 20)
})

test('nonsense returns noMatch instead of forcing a card', async () => {
  const value = await search(searcher, {
    query: '量子传送机',
    queryAlts: ['quantum teleportation machine'],
  })
  assert.equal(value.noMatch, true)
  assert.deepEqual(value.results, [])
  assert.equal(value.gates.gate1.passed, false)
})

test('gate1 caps hits at 8 and denominator at 8', () => {
  const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']
  const gate = evaluateGate1(record({
    name: 'x',
    description: terms.join(' '),
  }), terms)
  assert.equal(gate.hits, 8)
  assert.equal(gate.denominator, 8)
  assert.equal(gate.coverage, 1)
  assert.equal(gate.strongField, false)
  assert.equal(gate.pass, true)
})

test('gate1 rejects the dsh-auto-approve boundary at 3/8 coverage', () => {
  const gate = evaluateGate1(record({
    id: 'dsh-auto-approve',
    name: 'dsh-auto-approve',
    title: 'Jiao-XXX/dsh-auto-approve',
    topics: ['security'],
    capability: ['automation', 'terminal', 'security', 'notification', 'file'],
    description: 'An auto-approval permission preset between workspace-write and full access for DSH.',
  }), ['auto', 'approve', 'safe', 'workspace', 'edits', 'ask', 'dangerous', 'commands', 'outside', 'writes'])
  assert.equal(gate.hits, 3)
  assert.equal(gate.denominator, 8)
  assert.equal(gate.coverage, 0.375)
  assert.equal(gate.strongField, true)
  assert.equal(gate.pass, false)
})

test('noiseFilter levels change the gate1 threshold', () => {
  const item = record({
    id: 'dsh-auto-approve',
    name: 'dsh-auto-approve',
    title: 'Jiao-XXX/dsh-auto-approve',
    topics: ['security'],
    capability: ['automation', 'terminal', 'security', 'notification', 'file'],
    description: 'An auto-approval permission preset between workspace-write and full access for DSH.',
  })
  const terms = ['auto', 'approve', 'safe', 'workspace', 'edits', 'ask', 'dangerous', 'commands', 'outside', 'writes', 'terminal']
  assert.equal(evaluateGate1(item, terms, NOISE_FILTER_LEVELS.low.gate1).pass, true)
  assert.equal(evaluateGate1(item, terms, NOISE_FILTER_LEVELS.medium.gate1).pass, false)
  assert.equal(evaluateGate1(item, terms, NOISE_FILTER_LEVELS.high.gate1).pass, false)
})

test('gate1 accepts a strong name hit or two description hits', () => {
  const strong = evaluateGate1(record({ name: 'alpha', description: 'beta gamma delta' }), ['alpha', 'beta', 'gamma', 'delta'])
  assert.equal(strong.pass, true)
  const description = evaluateGate1(record({ name: 'x', description: 'alpha beta gamma delta' }), ['alpha', 'beta', 'gamma', 'delta'])
  assert.equal(description.pass, true)
  const single = evaluateGate1(record({ name: 'x', description: 'alpha' }), ['alpha', 'beta', 'gamma', 'delta'])
  assert.equal(single.pass, false)
})

test('noiseFilter none disables gate1 and returns lexical candidates', async () => {
  const medium = await search(searcher, {
    query: 'notifies',
    queryAlts: ['notifies'],
    noiseFilter: 'medium',
  })
  assert.equal(medium.noMatch, true)
  assert.equal(medium.gates.gate1.enabled, true)

  const none = await search(searcher, {
    query: 'notifies',
    queryAlts: ['notifies'],
    noiseFilter: 'none',
  })
  assert.equal(none.noMatch, false)
  assert.equal(none.gates.gate1.enabled, false)
  assert.ok(none.results.length > 0)
})

test('a negated capability excludes matching plugins', async () => {
  const cloud = record({
    id: 'dsh-cloud-ocr',
    name: 'dsh-cloud-ocr',
    alias: 'dsh-cloud-ocr',
    description: 'OCR through a cloud network service.',
    topics: ['vision', 'network'],
    capability: ['ocr', 'network'],
    repo: 'https://github.com/acme/cloud-ocr',
    repoKey: 'github.com/acme/cloud-ocr',
    install: { target: 'dsh-cloud-ocr' },
  })
  const local = record({
    id: 'dsh-local-ocr',
    name: 'dsh-local-ocr',
    alias: 'dsh-local-ocr',
    description: 'Offline OCR that runs entirely on your machine.',
    topics: ['vision'],
    capability: ['ocr'],
    repo: 'https://github.com/acme/local-ocr',
    repoKey: 'github.com/acme/local-ocr',
    install: { target: 'dsh-local-ocr' },
  })
  const custom = createSearcher([...records, cloud, local], { runtimeVersion: '0.2.1' })
  const value = await search(custom, {
    query: '要 OCR，但不要联网',
    queryAlts: ['OCR text extraction without network'],
    preset: 'balanced',
  })
  assert.ok(!value.results.some(result => result.name === 'dsh-cloud-ocr'))
  assert.ok(value.results.some(result => result.name === 'dsh-local-ocr'))
  assert.ok(value.filterStats.droppedBy.negation >= 1)
})

test('same-repo packages merge into one card with alternatives', async () => {
  const value = await search(searcher, {
    query: 'sidebar themes',
    queryAlts: ['sidebar layout', 'ui theme sidebar'],
    limit: 10,
    noiseFilter: 'none',
  })
  const sidebar = value.results.find(result => result.name === 'dsh-better-sidebar')
  assert.ok(sidebar)
  assert.ok(sidebar.alternatives.includes('dsh-sidebar-pack'))
})

test('dangerous plugins never reach the default results', async () => {
  const value = await search(searcher, { query: 'shell commands', queryAlts: ['terminal command runner'] })
  assert.ok(!value.results.some(result => result.name === 'dsh-risky'))
})

test('explain returns a full record and reports misses', () => {
  const found = explain(searcher, 'dsh-im-connect')
  assert.equal(found.explain.found, true)
  assert.equal(found.explain.install.target, 'dsh-im-connect')
  const missing = explain(searcher, 'no-such-plugin')
  assert.equal(missing.explain.found, false)
})

test('vector mode degrades honestly instead of downloading a model', async () => {
  const value = await vectorRerank([], [], { mode: 'fields', indexDir: '.', serverPath: '' })
  assert.equal(value.degraded, 'runtime-missing')
  assert.equal(value.covered, 0)
  assert.equal(await vectorRerank([], [], { mode: 'off' }), null)
})

test('the ten-result report stays within the context budget', async () => {
  const value = await search(searcher, {
    query: 'notify sidebar git',
    queryAlts: ['notification sidebar git review'],
  })
  const padded = {
    ...value,
    results: Array.from({ length: 10 }, (_, index) => ({
      ...value.results[index % Math.max(1, value.results.length)],
      id: `x-${index}`,
      name: `dsh-example-plugin-${index}`,
      description: 'A deliberately long English description that repeats itself to approach the clipping budget for every single result in this report.',
      stars: 12345,
      install: { target: `@scope/example-plugin-${index}@1.2.3` },
      badges: { verification: 'L5', security: 'low', updatedAt: '2026-10-18' },
    })),
  }
  padded.interpreted.filters.preset = 'balanced'
  const text = textReport(padded, { manifest: { sources: { dshSo: { generatedAt: '2026-10-22T00:00:00Z' } } } })
  const tokens = Math.ceil(text.length / 3)
  assert.ok(tokens <= 800, `report used about ${tokens} tokens`)
  assert.ok(text.includes('Powered by dsh.so — DSH Developer Hub'))
})
