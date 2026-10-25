import test from 'node:test'
import assert from 'node:assert/strict'
import { dropStopwords, extractNegation, minHitsFor, prepareQueries, tokenize } from '../lib/tokenize.js'

test('Chinese runs become overlapping bigrams plus the last character', () => {
  assert.deepEqual(tokenize('发微信'), ['发微', '微信', '信'])
  assert.deepEqual(tokenize('通知'), ['通知', '知'])
})

test('package names and camelCase split into words', () => {
  assert.deepEqual(tokenize('dsh-better-sidebar'), ['dsh', 'better', 'sidebar'])
  assert.deepEqual(tokenize('OpenBiliClaw'), ['open', 'bili', 'claw'])
})

test('query stopwords are removed but document tokens are not', () => {
  assert.deepEqual(dropStopwords(tokenize('帮我')), [])
  assert.ok(tokenize('帮我找一个能用的插件').length > 0)
  assert.ok(dropStopwords(tokenize('通知')).includes('通知'))
})

test('negation is captured and removed from positive terms', () => {
  const negated = extractNegation('要能 OCR，但不要联网')
  assert.ok(negated.not.includes('联网'))
  assert.ok(!negated.text.includes('不要'))
  const prepared = prepareQueries('要能 OCR，但不要联网', [])
  assert.ok(prepared.original.terms.includes('ocr'))
  assert.ok(!prepared.original.terms.includes('联网'))
})

test('minimum hits is one third of terms, rounded up, at least one', () => {
  assert.equal(minHitsFor([]), 1)
  assert.equal(minHitsFor(['a', 'b']), 1)
  assert.equal(minHitsFor(['a', 'b', 'c']), 2)
  assert.equal(minHitsFor(Array.from({ length: 20 }, (_, index) => String(index))), 7)
})

test('a Chinese long sentence still produces terms', () => {
  const prepared = prepareQueries('任务完成时给我发微信通知', [])
  assert.ok(prepared.original.terms.includes('微信'))
  assert.ok(prepared.original.terms.length >= 5)
})

test('rewrites are deduped and capped at three', () => {
  const prepared = prepareQueries('通知', ['notify', 'notify', 'wecom webhook', 'turn end', 'extra'])
  assert.equal(prepared.rewrites.length, 3)
})
