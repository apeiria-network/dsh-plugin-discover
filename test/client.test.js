/**
 * Load the Client half in Node with a tiny React/loader stub: proves the
 * factory registers its locale dictionaries and the row config slot, and that
 * both the summary and page views render without touching browser globals.
 */
import assert from 'node:assert/strict'

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) { definition = value },
  },
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
}

await import('../client.js')
assert.equal(definition.id, 'dsh-plugin-discover')
const module = definition.factory(name => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

const dictionaries = []
const slots = []
const configForm = {
  getSnapshot: () => ({
    status: 'ready',
    value: {
      indexDir: 'C:\\x',
      updateCycle: 'week',
      filterPreset: 'balanced',
      minVerificationLevel: 4,
      resultLimit: 10,
      noiseFilter: 'medium',
      vector: { mode: 'off', topN: 50 },
      readme: { requestTimeoutSeconds: 30, totalBudgetMinutes: 5, githubConcurrency: 4 },
    },
    base: {},
    user: {},
    revision: 1,
    writable: true,
  }),
  subscribe: () => () => {},
  mutate: async () => true,
}
const ctx = {
  effect(factory) { return factory() },
  locale: {
    register(ns, locale, dict) {
      dictionaries.push({ ns, locale, dict })
      return () => {}
    },
    bind() { return key => key },
  },
  configForms: {
    get(id) {
      assert.ok(['discover', 'include:discover', 'dsh-plugin-discover', 'dsh-plugin-discover#discover'].includes(id), `unexpected config id ${id}`)
      return configForm
    },
  },
  slots: {
    inject(name, factory) { return factory() },
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
  },
}
module.apply(ctx)

assert.deepEqual(dictionaries.map(entry => entry.locale).sort(), ['en', 'zh'])
const detail = slots.find(entry => entry.options.name === 'plugins.detail.section')
assert.ok(detail, 'detail config section must be registered')
assert.equal(detail.options.id, 'dsh-plugin-discover-config')
assert.equal(detail.options.locale, 'dshPluginDiscover')
for (const { dict } of dictionaries) {
  for (const key of ['summary', 'indexDir', 'updateCycle', 'day', 'week', 'month', 'quarter', 'updateCycleHint', 'searchSection', 'filterPreset', 'strict', 'balanced', 'loose', 'offFilter', 'strictDesc', 'balancedDesc', 'looseDesc', 'offDesc', 'autoRelaxHint', 'minVerificationLevel', 'noFloor', 'resultLimit', 'noiseFilter', 'noiseNone', 'noiseLow', 'noiseMedium', 'noiseHigh', 'noiseFilterHint', 'vectorMode', 'vectorSection', 'vectorTopN', 'vectorBalance', 'vectorHigh', 'readmeSection', 'requestTimeout', 'totalBudget', 'githubConcurrency', 'configTitle', 'save', 'loading']) {
    assert.equal(typeof dict[key], 'string', `missing dictionary key ${key}`)
  }
}

const t = key => key
const page = detail.component({
  subject: { kind: 'bundle', pkg: { name: 'dsh-plugin-discover' } },
  t,
})
assert.equal(page.type, 'section')
assert.ok(page.children.length >= 2)
assert.equal(detail.component({ subject: { kind: 'bundle', pkg: { name: 'other' } }, t }), null)
console.log('client half ok: dictionaries, detail config slot, form')
