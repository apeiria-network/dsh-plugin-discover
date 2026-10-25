/**
 * The model-facing text report. Two lines per candidate, no summary, no
 * recommendation prose: the model owns expression, this module owns facts.
 */
import { ATTRIBUTION } from './normalize.js'

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

function pad(value) {
  return String(value).padStart(2, '0')
}

function shortDate(value, now = new Date()) {
  if (typeof value !== 'string' || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  if (date.getFullYear() === now.getFullYear()) return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function verificationLabel(level) {
  if (level === 5) return 'L5 已验证'
  if (typeof level === 'number' && level >= 1 && level <= 5) return `L${level}`
  return ''
}

function securityLabel(security) {
  if (!security) return ''
  const status = security.status
  const risk = security.riskLevel
  if (status === 'failed') return '审计失败'
  if (status === 'pending' || status === 'skipped') return '未审计'
  if (risk === 'low') return '低风险'
  if (risk === 'medium') return '中风险'
  if (risk === 'high') return '高风险'
  if (risk === 'critical') return '严重风险'
  return ''
}

/** Rough token estimate: one per CJK character, one per four ASCII characters. */
function estimateTokens(text) {
  let tokens = 0
  for (const character of text) {
    tokens += character.codePointAt(0) >= 0x2e80 ? 1 : 0.25
  }
  return tokens
}

/** Clip a description to a per-item token budget without cutting a surrogate pair. */
function clipDescription(text, budget = 45) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value === '' || estimateTokens(value) <= budget) return value
  let kept = ''
  let tokens = 0
  for (const character of value) {
    const cost = character.codePointAt(0) >= 0x2e80 ? 1 : 0.25
    if (tokens + cost > budget) break
    tokens += cost
    kept += character
  }
  return `${kept.trimEnd()}…`
}

function starsLabel(stars) {
  if (typeof stars !== 'number' || !Number.isFinite(stars) || stars <= 0) return ''
  return `${stars >= 1000 ? Math.round(stars).toLocaleString('en-US') : stars}★`
}

function resultLines(result, index, now) {
  const badges = [starsLabel(result.stars)]
  const verification = verificationLabel(result.badges?.verification
    ? Number(String(result.badges.verification).replace('L', ''))
    : undefined)
  if (verification) badges.push(verification)
  const security = securityLabel(result.badges?.security
    ? { status: result.badges.security, riskLevel: result.badges.security }
    : null)
  if (security) badges.push(security)
  const updated = shortDate(result.badges?.updatedAt, now)
  if (updated) badges.push(`更新 ${updated}`)
  const visible = badges.filter(Boolean)
  const head = `${CIRCLED[index] ?? `${index + 1}.`} ${result.name}${visible.length ? ` · ${visible.join(' · ')}` : ''}`
  const description = clipDescription(result.description)
  const target = result.install?.target
  const suffix = target && target !== result.name ? `   [装: ${target}]` : ''
  return [head, `   ${description}${suffix}`]
}

function headerLine(value) {
  const parts = [`🔍 ${value.results.length} 个候选`]
  const preset = value.interpreted?.filters?.preset
  if (preset) {
    const dropped = value.filterStats?.droppedBy
    const total = dropped
      ? dropped.security + dropped.compat + dropped.verification + (dropped.negation ?? 0)
      : 0
    const relaxed = value.interpreted.filters.relaxedFrom
    parts.push(`过滤 ${preset}${relaxed ? `（已从 ${relaxed} 放宽）` : ''}（排除 ${total} 条）`)
  }
  if (value.vector) {
    const vector = value.vector
    if (vector.degraded) {
      parts.push(`向量 ${vector.mode} 不可用，已降级词面`)
    } else if (vector.mode === 'readme' && vector.readmeCovered !== undefined) {
      const sources = vector.readmeSources
      const detail = sources
        ? `（github ${sources.github ?? 0} · npm ${sources.npm ?? 0} · 字段 ${sources.fields ?? 0}）`
        : (vector.readmeFallback ? `（字段兜底 ${vector.readmeFallback}）` : '')
      parts.push(`向量 readme 覆盖 ${vector.readmeCovered}/50${detail}`)
    } else {
      parts.push(`向量 ${vector.mode} 覆盖 ${vector.covered}/50`)
    }
  }
  return parts.join(' · ')
}

function footerLines(manifest, now = new Date()) {
  const lines = []
  const sources = manifest?.manifest?.sources ?? manifest?.sources
  const generatedAt = sources?.dshSo?.generatedAt ?? manifest?.manifest?.generatedAt ?? manifest?.generatedAt
  if (manifest?.manifest?.catalogError || manifest?.catalogError) {
    lines.push('⚠️ catalog 源不可用，本次只用 dsh.so。')
  }
  if (generatedAt) {
    const date = new Date(generatedAt)
    if (!Number.isNaN(date.getTime())) {
      const ageDays = Math.floor((now.getTime() - date.getTime()) / 86_400_000)
      if (ageDays > 7) lines.push(`⚠️ 数据已 ${ageDays} 天未更新，可能未收录新插件。`)
      lines.push(`数据截至 ${date.toISOString().slice(0, 10)} · ${ATTRIBUTION}`)
      return lines
    }
  }
  lines.push(ATTRIBUTION)
  return lines
}

function noMatchLines(value, manifest, now) {
  const lines = [headerLine(value)]
  const dropped = value.filterStats?.droppedBy
  const total = dropped
    ? dropped.security + dropped.compat + dropped.verification + (dropped.negation ?? 0)
    : 0
  if (value.indexMissing) {
    lines.push('索引尚未建立。')
    lines.push('先执行：npx dsh-plugin-discover build，或用 refresh: true 触发一次后台建库。')
  } else if (value.explain?.found === false) {
    lines.push(`没有找到 id / 名称「${value.explain.id}」。可以先用一次普通检索拿到准确 id。`)
  } else if (value.gates?.gate1 && value.gates.gate1.passed === false
    && (!value.gates.gate2 || value.gates.gate2.passed === false)) {
    lines.push('没有候选通过证据检查（词面 gate1 / 语义 gate2），按没有匹配处理。')
    lines.push('建议：换成更具体的英文/术语改写；中文需求请同时给出 queryAlts 的英文改写；或去掉过于宽泛的改写词。')
  } else if (total > 0) {
    lines.push('没有候选同时满足检索词和过滤条件。')
    lines.push('建议：去掉「不要 / 除了」这类排除条件；换一个更具体的说法；或把过滤档位放宽到 loose。')
  } else {
    lines.push('索引里没有匹配这个需求的插件，这是正常结果，不要硬凑。')
    lines.push('建议：换成英文/术语说法再试；中文需求请同时给出 queryAlts 的英文改写；或先 refresh 更新索引。')
  }
  lines.push(...footerLines(manifest, now))
  return lines
}

function explainLines(value, manifest, now) {
  const item = value.explain
  if (!item || item.found === false) return noMatchLines(value, manifest, now)
  const badges = [starsLabel(item.stars)]
  const verification = verificationLabel(item.verification?.level)
  if (verification) badges.push(verification)
  const security = securityLabel(item.security)
  if (security) badges.push(security)
  const updated = shortDate(item.updatedAt, now)
  if (updated) badges.push(`更新 ${updated}`)
  const visible = badges.filter(Boolean)
  const lines = [
    `🔎 ${item.name}${visible.length ? ` · ${visible.join(' · ')}` : ''}`,
    `   ${String(item.description ?? '').replace(/\s+/g, ' ').trim()}`,
  ]
  const tags = [...(item.topics ?? []), ...(item.capability ?? [])]
  if (tags.length > 0) lines.push(`   标签：${[...new Set(tags)].join(', ')}`)
  if (item.install?.target) lines.push(`   安装目标：${item.install.target}`)
  if (item.repo) lines.push(`   仓库：${item.repo}`)
  if (item.dshRange) lines.push(`   兼容范围：${item.dshRange}`)
  if (item.verification) {
    lines.push(`   验证：${item.verification.label ?? `L${item.verification.level}`}`
      + `${item.verification.lastVerifiedAt ? `（${item.verification.lastVerifiedAt.slice(0, 10)}）` : ''}`)
  }
  if (item.security) {
    const counts = item.security.counts
    lines.push(`   安全：${item.security.status} / ${item.security.riskLevel}`
      + `${counts ? `（critical ${counts.critical} · warning ${counts.warning}）` : ''}`)
  }
  if (item.url) lines.push(`   详情：${item.url}`)
  if (item.alternatives?.length) lines.push(`   同仓库其他包：${item.alternatives.map(alt => alt.name).join(', ')}`)
  lines.push(...footerLines(manifest, now))
  return lines
}

/**
 * Render the report.
 * @param {object} value tool value
 * @param {{ manifest?: object, building?: boolean, indexing?: boolean, now?: Date }} state
 */
export function textReport(value, state = {}) {
  const now = state.now ?? new Date()
  const circuit = value.vector?.circuit?.open && value.vector?.notice
    ? `⚠️ ${value.vector.notice}`
    : ''
  const indexNotice = value.index?.notice ? `⚠️ ${value.index.notice}` : ''
  const notices = [circuit, indexNotice].filter(Boolean)
  if (value.refresh) {
    const refresh = value.refresh
    return [
      refresh.started ? '📚 已开始后台建库，立即返回；建好后重新检索即可。' : '📚 建库没有启动。',
      refresh.reason === 'running' ? '已有一个建库任务在运行。' : '',
      refresh.reason === 'locked' ? '另一个进程持有建库锁。' : '',
      ATTRIBUTION,
    ].filter(Boolean).join('\n')
  }
  if (state.indexing) {
    return [
      '🔍 索引尚未建立。',
      '已在后台开始建库（首次约 1–3 分钟，约 25 MB 下载）；建好后重新调用即可。',
      '也可以前台执行：npx dsh-plugin-discover build',
      ATTRIBUTION,
    ].join('\n')
  }
  if (value.explain) return explainLines(value, state.manifest, now).join('\n')
  if (value.results.length === 0) {
    const lines = noMatchLines(value, state.manifest, now)
    if (notices.length > 0) lines.unshift(...notices)
    return lines.join('\n')
  }

  const lines = [headerLine(value), '']
  if (notices.length > 0) lines.unshift(...notices)
  value.results.forEach((result, index) => {
    lines.push(...resultLines(result, index, now))
  })
  lines.push('')
  lines.push(...footerLines(state.manifest, now))
  if (state.building) lines.push('⏳ 索引正在后台更新，当前结果来自上一版索引。')
  if (state.lastError) lines.push('⚠️ 上次建库失败，当前结果来自上一版索引。')
  return lines.join('\n')
}
