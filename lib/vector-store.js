/**
 * fp16 vector and README-excerpt caches outside the immutable index
 * directories, keyed by content hash so a rebuilt index reuses unchanged work.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** One fp16 value; inputs are normalized to [-1, 1]. */
export function float32ToFloat16(value) {
  const buffer = new ArrayBuffer(4)
  const floatView = new Float32Array(buffer)
  const intView = new Int32Array(buffer)
  floatView[0] = value
  const bits = intView[0]
  const sign = (bits >> 16) & 0x8000
  let exponent = (bits >> 23) & 0xff
  let mantissa = bits & 0x7fffff
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0)
  const halfExponent = exponent - 127 + 15
  if (halfExponent >= 31) return sign | 0x7c00
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign
    mantissa = (mantissa | 0x800000) >> (1 - halfExponent)
    return sign | ((mantissa + 0x1000) >> 13)
  }
  return sign | (halfExponent << 10) | ((mantissa + 0x1000) >> 13)
}

/** Decode one fp16 bit pattern. */
export function float16ToFloat32(bits) {
  const sign = bits & 0x8000 ? -1 : 1
  const exponent = (bits >> 10) & 0x1f
  const mantissa = bits & 0x3ff
  if (exponent === 0) return sign * mantissa * 2 ** -24
  if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
}

/** Serialize a 384-dimensional float vector as base64 of its fp16 bits. */
export function encodeVector(vector) {
  const bits = new Uint16Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) bits[index] = float32ToFloat16(vector[index])
  return Buffer.from(bits.buffer).toString('base64')
}

/** Decode a base64 fp16 vector back to float32. */
export function decodeVector(base64) {
  const buffer = Buffer.from(base64, 'base64')
  const bits = new Uint16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2))
  const vector = new Float32Array(bits.length)
  for (let index = 0; index < bits.length; index += 1) vector[index] = float16ToFloat32(bits[index])
  return vector
}

/** Deterministic short hash used for excerpt and content keys. */
export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

function readJsonLines(file) {
  const map = new Map()
  if (!existsSync(file)) return map
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const value = JSON.parse(trimmed)
        if (value && typeof value.k === 'string') map.set(value.k, value)
      } catch {}
    }
  } catch {}
  return map
}

/** One store per index directory; caches survive index rebuilds. */
export class VectorStore {
  constructor(indexDir) {
    this.indexDir = indexDir
    this.dir = join(indexDir, 'cache')
    this.fields = null
    this.readmes = null
    this.excerpts = null
    this.pending = { fields: [], readmes: [], excerpts: [] }
  }

  file(name) {
    return join(this.dir, name)
  }

  ensureDir() {
    mkdirSync(this.dir, { recursive: true })
  }

  getField(key) {
    this.fields ??= readJsonLines(this.file('field-vectors.jsonl'))
    return this.fields.get(key) ?? null
  }

  setField(key, vector, contentHash) {
    const value = { k: key, v: encodeVector(vector), at: Date.now(), contentHash }
    this.fields ??= readJsonLines(this.file('field-vectors.jsonl'))
    this.fields.set(key, value)
    this.pending.fields.push(value)
  }

  getReadme(key) {
    this.readmes ??= readJsonLines(this.file('readme-vectors.jsonl'))
    return this.readmes.get(key) ?? null
  }

  setReadme(key, vector, excerptHash) {
    const value = { k: key, v: encodeVector(vector), at: Date.now(), excerptHash }
    this.readmes ??= readJsonLines(this.file('readme-vectors.jsonl'))
    this.readmes.set(key, value)
    this.pending.readmes.push(value)
  }

  getExcerpt(repo) {
    this.excerpts ??= readJsonLines(this.file('readme-excerpts.jsonl'))
    return this.excerpts.get(repo) ?? null
  }

  setExcerpt(repo, excerpt) {
    const value = { k: repo, ...excerpt, at: Date.now() }
    this.excerpts ??= readJsonLines(this.file('readme-excerpts.jsonl'))
    this.excerpts.set(repo, value)
    this.pending.excerpts.push(value)
  }

  flush() {
    this.ensureDir()
    for (const [name, values] of Object.entries(this.pending)) {
      if (values.length === 0) continue
      const file = this.file(`${name === 'fields' ? 'field-vectors' : name === 'readmes' ? 'readme-vectors' : 'readme-excerpts'}.jsonl`)
      appendFileSync(file, values.map(value => `${JSON.stringify(value)}\n`).join(''))
      values.length = 0
    }
  }
}
