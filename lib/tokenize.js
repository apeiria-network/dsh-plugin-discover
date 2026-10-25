/**
 * Query and document tokenization. Chinese runs use overlapping bigrams plus
 * the last character — no dictionary, no segmenter. Stopwords and negation
 * apply to queries only; the indexed documents keep every token.
 */

const EN_STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
  'to', 'for', 'of', 'in', 'on', 'with', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'want', 'wants', 'need',
  'needs', 'please', 'help', 'some', 'any', 'how', 'what', 'which', 'when', 'where', 'who',
  'why', 'plugin', 'plugins', 'dsh', 'deepseek', 'harness', 'tool', 'tools', 'something',
  'into', 'from', 'at', 'by', 'as', 'about', 'after', 'before', 'over', 'under', 'between',
  'through', 'during', 'out', 'up', 'down', 'off', 'again', 'more', 'most', 'other', 'such',
  'only', 'own', 'same', 'too', 'very', 'just', 'now', 'also', 'make', 'makes', 'making',
  'get', 'gets', 'getting', 'give', 'gives', 'take', 'takes', 'use', 'uses', 'using', 'used',
  'like', 'well', 'even', 'still', 'back', 'way', 'thing', 'things',
])

const ZH_STOPWORDS = new Set([
  '帮我', '帮忙', '我想', '我要', '想要', '一个', '这个', '那个', '可以', '能否', '能够', '需要',
  '希望', '请问', '有没有', '什么', '怎么', '如何', '哪些', '哪个', '插件', '工具', '功能',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '的', '了', '吗', '呢', '吧', '啊',
  '请', '找', '要', '做', '用', '在', '有', '和', '与', '或', '及', '就', '也', '都', '还',
  '不', '没', '没有', '能', '会', '把', '给', '被', '让', '对', '从', '到', '上', '下',
  '但', '但是', '不过', '然而', '而且', '并且', '或者', '还是', '如果', '因为', '所以', '然后',
])

const NEGATION_RE = /(?:不要|除了|不含|不带|无需|不想|without|except(?:ing)?|exclude)\s*([^，。；;,.!?！？\n]+)/gi

function isCjk(code) {
  return (code >= 0x3400 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
}

function splitCamel(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

/** Tokenize one string into lowercase words and CJK bigrams. */
export function tokenize(text) {
  if (typeof text !== 'string' || text === '') return []
  const value = splitCamel(text.normalize('NFKC'))
  const tokens = []
  let latin = ''
  let cjk = ''
  const flushLatin = () => {
    if (latin.length >= 2 && !/^\d+$/.test(latin)) tokens.push(latin)
    latin = ''
  }
  const flushCjk = () => {
    if (cjk.length === 0) return
    if (cjk.length === 1) {
      tokens.push(cjk)
    } else {
      for (let index = 0; index + 1 < cjk.length; index += 1) tokens.push(cjk.slice(index, index + 2))
      tokens.push(cjk.slice(-1))
    }
    cjk = ''
  }
  for (const character of value) {
    const code = character.codePointAt(0)
    if (isCjk(code)) {
      flushLatin()
      cjk += character
      continue
    }
    flushCjk()
    if (/[\p{L}\p{N}]/u.test(character)) latin += character.toLowerCase()
    else flushLatin()
  }
  flushLatin()
  flushCjk()
  return tokens
}

/** Remove query stopwords, preserving order. */
export function dropStopwords(tokens) {
  return tokens.filter(token => !EN_STOPWORDS.has(token) && !ZH_STOPWORDS.has(token))
}

/** Pull negated clauses out of a query, returning the cleaned text and the exclusions. */
export function extractNegation(text) {
  if (typeof text !== 'string' || text === '') return { text: '', not: [] }
  const not = []
  const cleaned = text.replace(NEGATION_RE, (_match, clause) => {
    const terms = dropStopwords(tokenize(clause))
      .filter(term => term.length >= 2)
      .slice(0, 3)
    for (const term of terms) if (!not.includes(term)) not.push(term)
    return ' '
  })
  return { text: cleaned, not }
}

/** Prepare one route: cleaned text, positive terms, and exclusions. */
export function prepareQuery(text) {
  if (typeof text !== 'string' || text.trim() === '') return { text: '', terms: [], not: [] }
  const { text: cleaned, not } = extractNegation(text)
  let terms = dropStopwords(tokenize(cleaned))
  if (terms.length === 0) terms = tokenize(cleaned)
  const excluded = new Set(not)
  terms = [...new Set(terms)].filter(term => !excluded.has(term))
  return { text: cleaned.trim(), terms, not }
}

/**
 * Prepare the query group: the original plus up to three model rewrites.
 * The original's negations apply to every route.
 */
export function prepareQueries(query, alts = []) {
  const original = prepareQuery(query)
  const rewrites = []
  const seen = new Set()
  for (const alt of Array.isArray(alts) ? alts : []) {
    if (typeof alt !== 'string' || alt.trim() === '') continue
    const packet = prepareQuery(alt)
    if (packet.terms.length === 0) continue
    const key = packet.terms.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    rewrites.push(packet)
    if (rewrites.length >= 3) break
  }
  const not = [...new Set([...original.not, ...rewrites.flatMap(packet => packet.not)])]
  const excluded = new Set(not)
  const clean = packet => ({ ...packet, terms: packet.terms.filter(term => !excluded.has(term)) })
  return {
    original: clean(original),
    rewrites: rewrites.map(clean),
    not,
  }
}

/** The minimum distinct terms a document must match for one route. */
export function minHitsFor(terms) {
  return Math.max(1, Math.ceil(terms.length * 0.34))
}
