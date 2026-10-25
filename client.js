window.__ModuleLoader__.load({
  id: 'dsh-plugin-discover',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dshPluginDiscover'
    const COPY = {
      zh: {
        summary: '本地插件检索 · 中文口语查询 · 过滤、向量化增强与 README 抓取',
        indexDir: '索引目录',
        indexDirHint: '默认按用户全局固定。修改后 CLI 需用 --index-dir 指向同一目录。',
        updateCycle: '索引更新周期',
        day: '天（1 天）',
        week: '周（7 天，默认）',
        month: '月（30 天）',
        quarter: '3 个月（90 天）',
        updateCycleHint: '用户发起插件检索时检查；索引超过此周期会先等待刷新完成，再开始检索。',
        searchSection: '检索与过滤',
        filterPreset: '过滤档位',
        strict: '严格',
        balanced: '均衡（默认）',
        loose: '宽松',
        offFilter: '关闭',
        strictDesc: '保留验证等级 L5、安全审计 audited low、兼容性已知通过的条目。',
        balancedDesc: '要求验证等级不低于下限；排除 audited high/critical；未知验证和未知兼容保留。',
        looseDesc: '只排除 audited high/critical；不设验证等级下限，兼容性全部保留。',
        offDesc: '只排除 audited critical；其余全部保留。',
        autoRelaxHint: '候选不足 3 条时，会自动放宽一档。',
        minVerificationLevel: '最低验证等级（仅均衡档）',
        minVerificationHint: '0 = 不限；1–5 要求验证等级 ≥ N。未知验证等级不会被删；严格档固定 L5，宽松/关闭不设下限。',
        noFloor: '0 — 不限',
        resultLimit: '结果返回数量（top N）',
        resultLimitHint: '范围 1–20，默认 10；综合检索与向量化增强后交给会话 LLM 确认。',
        noiseFilter: '无关结果筛选强度',
        noiseNone: 'none（关闭）',
        noiseLow: 'low（宽松）',
        noiseMedium: 'medium（均衡，默认）',
        noiseHigh: 'high（严格）',
        noiseFilterHint: 'none 关闭 gate1/gate2；low/medium/high 逐级提高词面覆盖率和向量相似度阈值。只影响 noMatch 判断，不改变排序。',
        vectorMode: '向量化检索增强',
        vectorSection: '向量化检索增强',
        vectorOff: 'off',
        vectorBalance: 'balance',
        vectorHigh: 'high',
        vectorHint: '平衡和极强模式需要下载向量化模型包；极强模式还需要联网抓取 GitHub README 文档，速度较慢。',
        vectorTopN: '向量化范围（top N）',
        vectorTopNHint: '范围 2–200，默认 50；检索算法得到的 topN 结果作为向量化增强候选。向量化增强为 off 时不生效。',
        readmeSection: 'README 抓取',
        readmeHint: '仅在向量化检索增强为 high 时生效；保存后热生效。',
        configTitle: '配置',
        requestTimeout: '单请求超时（秒）',
        requestTimeoutHint: '默认 30；范围 5–300。',
        totalBudget: 'README抓取总超时时长（分钟）',
        totalBudgetHint: '范围 1–10，默认 5；超时后剩余记录直接走 npm CDN。',
        githubConcurrency: 'GitHub 请求并发',
        githubConcurrencyHint: '默认 4；范围 1–8。',
        buildHint: '更新索引：npx dsh-plugin-discover build，或在会话里让模型调用 plugin_discover 并传 refresh: true。',
        save: '保存',
        saving: '保存中…',
        loading: '加载中…',
        saved: '已保存，配置会热生效。',
        saveFailed: '保存失败，请重试。',
        noChanges: '没有改动。',
        unavailable: '配置暂不可用。',
        readOnly: '当前配置只读。',
      },
      en: {
        summary: 'Local plugin search · Chinese natural language · filters, vector enhancement, and README fetching',
        indexDir: 'Index directory',
        indexDirHint: 'Shared per user by default. After changing it, point the CLI at the same directory with --index-dir.',
        updateCycle: 'Index update cycle',
        day: 'Day (1 day)',
        week: 'Week (7 days, default)',
        month: 'Month (30 days)',
        quarter: '3 months (90 days)',
        updateCycleHint: 'Checked when the user asks to search plugins; an older index is refreshed and the search waits for it.',
        searchSection: 'Search and filters',
        filterPreset: 'Filter preset',
        strict: 'Strict',
        balanced: 'Balanced (default)',
        loose: 'Loose',
        offFilter: 'Off',
        strictDesc: 'Keeps only audited-low, L5, known-compatible entries.',
        balancedDesc: 'Applies the verification floor; excludes audited high/critical; keeps unknown verification and compatibility.',
        looseDesc: 'Excludes audited high/critical only; no verification floor; compatibility is unrestricted.',
        offDesc: 'Excludes audited critical only; everything else is kept.',
        autoRelaxHint: 'If fewer than three entries survive, the filter automatically relaxes one step.',
        minVerificationLevel: 'Minimum verification level (balanced only)',
        minVerificationHint: '0 = no floor; 1–5 require level ≥ N. Unknown verification is kept; strict fixes L5; loose/off have no floor.',
        noFloor: '0 — no floor',
        resultLimit: 'Result count (top N)',
        resultLimitHint: 'Range 1–20, default 10; the combined lexical and vector ranking is handed to the session LLM.',
        noiseFilter: 'Irrelevant-result filter strength',
        noiseNone: 'none (off)',
        noiseLow: 'low (lenient)',
        noiseMedium: 'medium (balanced, default)',
        noiseHigh: 'high (strict)',
        noiseFilterHint: 'none disables gate1/gate2; low/medium/high raise the lexical coverage and vector similarity thresholds. It only decides noMatch and never changes ranking.',
        vectorMode: 'Vector search enhancement',
        vectorSection: 'Vector search enhancement',
        vectorOff: 'off',
        vectorBalance: 'balance',
        vectorHigh: 'high',
        vectorHint: 'Balance and high need the optional vector model package; high also fetches GitHub READMEs over the network, so it is slower.',
        vectorTopN: 'Vectorization range (top N)',
        vectorTopNHint: 'Range 2–200, default 50; the topN lexical results become vector candidates. Ignored when enhancement is off.',
        readmeSection: 'README fetching',
        readmeHint: 'Applies only when vector enhancement is high; changes take effect live.',
        configTitle: 'Configuration',
        requestTimeout: 'Single-request timeout (seconds)',
        requestTimeoutHint: 'Default 30; range 5–300.',
        totalBudget: 'Total README fetch timeout (minutes)',
        totalBudgetHint: 'Range 1–10, default 5; after it, remaining records go straight to the npm CDN.',
        githubConcurrency: 'GitHub request concurrency',
        githubConcurrencyHint: 'Default 4; range 1–8.',
        buildHint: 'Update the index with npx dsh-plugin-discover build, or call plugin_discover with refresh: true.',
        save: 'Save',
        saving: 'Saving…',
        loading: 'Loading…',
        saved: 'Saved. The configuration reloads live.',
        saveFailed: 'Save failed. Try again.',
        noChanges: 'No changes.',
        unavailable: 'Configuration is unavailable.',
        readOnly: 'This configuration is read-only.',
      },
    }

    function option(value, label) {
      return h('option', { key: value, value }, label)
    }

    function field(label, hint, control) {
      return h('label', { style: { display: 'grid', gap: 6 } }, [
        h('span', { key: 'label', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
        control,
        hint ? h('span', { key: 'hint', style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 } }, hint) : null,
      ])
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
    }

    function displayVectorMode(value) {
      if (value === 'fields') return 'balance'
      if (value === 'readme') return 'high'
      return value === 'balance' || value === 'high' ? value : 'off'
    }

    function ConfigPage(props) {
      const { t, form } = props
      const state = form?.state
      const value = state?.value ?? {}
      const [draft, setDraft] = React.useState(() => ({
        indexDir: String(value.indexDir ?? ''),
        updateCycle: String(value.updateCycle ?? 'week'),
        filterPreset: String(value.filterPreset ?? 'balanced'),
        minVerificationLevel: Number(value.minVerificationLevel ?? 4),
        resultLimit: Number(value.resultLimit ?? 10),
        noiseFilter: String(value.noiseFilter ?? 'medium'),
        vectorMode: displayVectorMode(value.vector?.mode),
        vectorTopN: Number(value.vector?.topN ?? 50),
        requestTimeoutSeconds: Number(value.readme?.requestTimeoutSeconds ?? 30),
        totalBudgetMinutes: Number(value.readme?.totalBudgetMinutes ?? 5),
        githubConcurrency: Number(value.readme?.githubConcurrency ?? 4),
      }))
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        setDraft({
          indexDir: String(value.indexDir ?? ''),
          updateCycle: String(value.updateCycle ?? 'week'),
          filterPreset: String(value.filterPreset ?? 'balanced'),
          minVerificationLevel: Number(value.minVerificationLevel ?? 4),
          resultLimit: Number(value.resultLimit ?? 10),
          noiseFilter: String(value.noiseFilter ?? 'medium'),
          vectorMode: displayVectorMode(value.vector?.mode),
          vectorTopN: Number(value.vector?.topN ?? 50),
          requestTimeoutSeconds: Number(value.readme?.requestTimeoutSeconds ?? 30),
          totalBudgetMinutes: Number(value.readme?.totalBudgetMinutes ?? 5),
          githubConcurrency: Number(value.readme?.githubConcurrency ?? 4),
        })
      }, [state?.revision])

      if (!form || !state) return h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('unavailable'))
      if (state.status === 'loading') return h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
      if (state.status === 'unavailable') return h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('unavailable'))
      const disabled = state.writable === false || busy
      const presetDescriptions = [
        ['strict', t('strict'), t('strictDesc')],
        ['balanced', t('balanced'), t('balancedDesc')],
        ['loose', t('loose'), t('looseDesc')],
        ['off', t('offFilter'), t('offDesc')],
      ]

      const update = (key, next) => setDraft(current => ({ ...current, [key]: next }))

      async function save() {
        const current = state.value ?? {}
        const ops = []
        if (draft.indexDir !== String(current.indexDir ?? '')) ops.push({ op: 'set', path: ['indexDir'], value: draft.indexDir })
        if (draft.updateCycle !== String(current.updateCycle ?? 'week')) {
          ops.push({ op: 'set', path: ['updateCycle'], value: draft.updateCycle })
        }
        if (draft.filterPreset !== String(current.filterPreset ?? 'balanced')) ops.push({ op: 'set', path: ['filterPreset'], value: draft.filterPreset })
        if (Number(draft.minVerificationLevel) !== Number(current.minVerificationLevel ?? 4)) {
          ops.push({ op: 'set', path: ['minVerificationLevel'], value: Number(draft.minVerificationLevel) })
        }
        if (Number(draft.resultLimit) !== Number(current.resultLimit ?? 10)) {
          ops.push({ op: 'set', path: ['resultLimit'], value: Number(draft.resultLimit) })
        }
        if (draft.noiseFilter !== String(current.noiseFilter ?? 'medium')) {
          ops.push({ op: 'set', path: ['noiseFilter'], value: draft.noiseFilter })
        }
        if (draft.vectorMode !== displayVectorMode(current.vector?.mode)) {
          ops.push({ op: 'set', path: ['vector', 'mode'], value: draft.vectorMode })
        }
        if (Number(draft.vectorTopN) !== Number(current.vector?.topN ?? 50)) {
          ops.push({ op: 'set', path: ['vector', 'topN'], value: Number(draft.vectorTopN) })
        }
        if (Number(draft.requestTimeoutSeconds) !== Number(current.readme?.requestTimeoutSeconds ?? 30)) {
          ops.push({ op: 'set', path: ['readme', 'requestTimeoutSeconds'], value: Number(draft.requestTimeoutSeconds) })
        }
        if (Number(draft.totalBudgetMinutes) !== Number(current.readme?.totalBudgetMinutes ?? 5)) {
          ops.push({ op: 'set', path: ['readme', 'totalBudgetMinutes'], value: Number(draft.totalBudgetMinutes) })
        }
        if (Number(draft.githubConcurrency) !== Number(current.readme?.githubConcurrency ?? 4)) {
          ops.push({ op: 'set', path: ['readme', 'githubConcurrency'], value: Number(draft.githubConcurrency) })
        }
        if (ops.length === 0) {
          setStatus(t('noChanges'))
          return
        }
        setBusy(true)
        setStatus('')
        try {
          const ok = await form.mutate(ops, state.revision)
          setStatus(ok ? t('saved') : t('saveFailed'))
        } catch {
          setStatus(t('saveFailed'))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'grid', gap: 16, maxWidth: 620 } }, [
        field(t('indexDir'), t('indexDirHint'), h('input', {
          key: 'indexDir',
          type: 'text',
          value: draft.indexDir,
          disabled,
          spellCheck: false,
          style: inputStyle,
          onChange: event => update('indexDir', event.target.value),
        })),
        field(t('updateCycle'), t('updateCycleHint'), h('select', {
          key: 'updateCycle',
          value: draft.updateCycle,
          disabled,
          style: inputStyle,
          onChange: event => update('updateCycle', event.target.value),
        }, [
          option('day', t('day')),
          option('week', t('week')),
          option('month', t('month')),
          option('quarter', t('quarter')),
        ])),
        h('h3', { key: 'searchSection', style: { margin: '4px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('searchSection')),
        field(t('filterPreset'), t('autoRelaxHint'), h('select', {
          key: 'filterPreset',
          value: draft.filterPreset,
          disabled,
          style: inputStyle,
          onChange: event => update('filterPreset', event.target.value),
        }, [
          option('strict', t('strict')),
          option('balanced', t('balanced')),
          option('loose', t('loose')),
          option('off', t('offFilter')),
        ])),
        h('div', {
          key: 'presetDescriptions',
          style: {
            display: 'grid',
            gap: 6,
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 6,
            background: 'var(--dsw-alias-bg-layer-1)',
          },
        }, presetDescriptions.map(([key, label, description]) => h('div', {
          key,
          style: { fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
        }, [
          h('strong', { key: 'label', style: { color: 'var(--dsw-alias-label-primary)' } }, `${label}：`),
          h('span', { key: 'text' }, description),
        ]))),
        field(t('minVerificationLevel'), t('minVerificationHint'), h('select', {
          key: 'minVerificationLevel',
          value: String(draft.minVerificationLevel),
          disabled,
          style: inputStyle,
          onChange: event => update('minVerificationLevel', Number(event.target.value)),
        }, [0, 1, 2, 3, 4, 5].map(level => option(String(level), level === 0 ? t('noFloor') : `L${level}`)))),
        field(t('resultLimit'), t('resultLimitHint'), h('input', {
          key: 'resultLimit',
          type: 'number',
          min: 1,
          max: 20,
          step: 1,
          value: draft.resultLimit,
          disabled,
          style: inputStyle,
          onChange: event => update('resultLimit', Number(event.target.value)),
        })),
        field(t('noiseFilter'), t('noiseFilterHint'), h('select', {
          key: 'noiseFilter',
          value: draft.noiseFilter,
          disabled,
          style: inputStyle,
          onChange: event => update('noiseFilter', event.target.value),
        }, [
          option('none', t('noiseNone')),
          option('low', t('noiseLow')),
          option('medium', t('noiseMedium')),
          option('high', t('noiseHigh')),
        ])),
        h('h3', { key: 'vectorSection', style: { margin: '4px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('vectorSection')),
        field(t('vectorMode'), t('vectorHint'), h('select', {
          key: 'vectorMode',
          value: draft.vectorMode,
          disabled,
          style: inputStyle,
          onChange: event => update('vectorMode', event.target.value),
        }, [
          option('off', t('vectorOff')),
          option('balance', t('vectorBalance')),
          option('high', t('vectorHigh')),
        ])),
        field(t('vectorTopN'), t('vectorTopNHint'), h('input', {
          key: 'vectorTopN',
          type: 'number',
          min: 2,
          max: 200,
          step: 1,
          value: draft.vectorTopN,
          disabled,
          style: inputStyle,
          onChange: event => update('vectorTopN', Number(event.target.value)),
        })),
        h('h3', { key: 'readmeSection', style: { margin: '4px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('readmeSection')),
        field(t('requestTimeout'), t('requestTimeoutHint'), h('input', {
          key: 'requestTimeoutSeconds',
          type: 'number',
          min: 5,
          max: 300,
          step: 1,
          value: draft.requestTimeoutSeconds,
          disabled,
          style: inputStyle,
          onChange: event => update('requestTimeoutSeconds', Number(event.target.value)),
        })),
        field(t('totalBudget'), t('totalBudgetHint'), h('input', {
          key: 'totalBudgetMinutes',
          type: 'number',
          min: 1,
          max: 10,
          step: 1,
          value: draft.totalBudgetMinutes,
          disabled,
          style: inputStyle,
          onChange: event => update('totalBudgetMinutes', Number(event.target.value)),
        })),
        field(t('githubConcurrency'), t('githubConcurrencyHint'), h('input', {
          key: 'githubConcurrency',
          type: 'number',
          min: 1,
          max: 8,
          step: 1,
          value: draft.githubConcurrency,
          disabled,
          style: inputStyle,
          onChange: event => update('githubConcurrency', Number(event.target.value)),
        })),
        h('p', { key: 'readmeHint', style: { margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t('readmeHint')),
        h('p', { key: 'buildHint', style: { margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } }, t('buildHint')),
        h('div', { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: 12 } }, [
          h('button', {
            key: 'save',
            type: 'button',
            disabled,
            onClick: () => { void save() },
            style: {
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--dsw-alias-brand-primary)',
              color: '#fff',
              fontSize: 13,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            },
          }, busy ? t('saving') : t('save')),
          status ? h('span', {
            key: 'status',
            role: 'status',
            style: {
              fontSize: 12,
              color: status === t('saveFailed') ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
            },
          }, status) : null,
          state.writable === false ? h('span', { key: 'readonly', style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, t('readOnly')) : null,
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', COPY.zh), 'dsh-plugin-discover: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', COPY.en), 'dsh-plugin-discover: en dictionary')
        const configForms = ['include:discover', 'discover', 'dsh-plugin-discover', 'dsh-plugin-discover#discover']
          .map(id => ctx.configForms.get(id))
        const readyForm = () => configForms.find(entry => entry.getSnapshot().status === 'ready') ?? configForms[0]
        const t = ctx.locale.bind(NS)

        function DetailConfig(props) {
          const subject = props?.subject
          const [form, setForm] = React.useState(readyForm)
          const [state, setState] = React.useState(() => form.getSnapshot())
          React.useEffect(() => {
            const offs = configForms.map(entry => entry.subscribe(() => {
              const next = readyForm()
              setForm(next)
              setState(next.getSnapshot())
            }))
            return () => offs.forEach(off => off())
          }, [])
          if (subject?.kind !== 'bundle' || subject.pkg?.name !== 'dsh-plugin-discover') return null
          return h('section', {
            'data-plugin-discover-config': true,
            style: { display: 'grid', gap: 12, marginTop: 8 },
          }, [
            h('h4', {
              key: 'title',
              style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
            }, t('configTitle')),
            h(ConfigPage, {
              key: 'form',
              t,
              form: {
                state,
                mutate: (ops, revision) => form.mutate(ops, revision),
              },
            }),
          ])
        }

        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-plugin-discover-config',
          locale: NS,
        }, DetailConfig))
      },
    }
  },
})
