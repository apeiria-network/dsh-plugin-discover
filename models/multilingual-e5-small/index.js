/**
 * Optional embedding model for dsh-plugin-discover.
 *
 * The weights are int8-quantized multilingual-e5-small (384 dimensions, 512
 * tokens). Queries and passages use the e5 prefixes, the tokenizer input is
 * truncated to the limit, the token vectors are mean-pooled (not CLS), and the
 * result is L2-normalized so a dot product is a cosine similarity.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Tokenizer } from '@huggingface/tokenizers'
import * as ort from 'onnxruntime-node'

export const MODEL_ID = 'multilingual-e5-small'
export const DIMENSIONS = 384
export const MAX_TOKENS = 512
export const PREFIXES = Object.freeze({ query: 'query: ', passage: 'passage: ' })

function local(name) {
  return fileURLToPath(new URL(name, import.meta.url))
}

/** Absolute paths of the files shipped in this package. */
export function modelPaths() {
  return {
    model: local('model_quantized.onnx'),
    tokenizer: local('tokenizer.json'),
    tokenizerConfig: local('tokenizer_config.json'),
    config: local('config.json'),
    manifest: local('manifest.json'),
  }
}

/** Read and validate the package manifest. */
export function readManifest() {
  return JSON.parse(fs.readFileSync(local('manifest.json'), 'utf8'))
}

function encodeIds(tokenizer, text, kind, maxTokens) {
  const prefix = PREFIXES[kind] ?? ''
  const value = typeof text === 'string' ? text : ''
  const input = value.startsWith(prefix) ? value : `${prefix}${value}`
  let ids = tokenizer.encode(input).ids
  if (ids.length > maxTokens) ids = [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]]
  return ids
}

function meanPoolNormalize(tensor) {
  const [, length, hidden] = tensor.dims
  const vector = new Float32Array(hidden)
  for (let i = 0; i < length; i += 1) {
    const offset = i * hidden
    for (let j = 0; j < hidden; j += 1) vector[j] += tensor.data[offset + j]
  }
  let norm = 0
  for (let j = 0; j < hidden; j += 1) norm += vector[j] * vector[j]
  norm = Math.sqrt(norm) || 1
  for (let j = 0; j < hidden; j += 1) vector[j] /= norm
  return vector
}

/**
 * Load the tokenizer and ONNX session.
 * @param {{ maxTokens?: number, sessionOptions?: object }} options
 */
export async function createEmbedder(options = {}) {
  const paths = modelPaths()
  const maxTokens = Number.isInteger(options.maxTokens) ? options.maxTokens : MAX_TOKENS
  // Do not let ONNX claim every logical core. The default 16-thread pool
  // saturated the machine, then inference degraded badly under CPU
  // quota/thermal pressure. Four threads keep one query under the 5 s budget
  // while leaving most cores for the Host and the rest of the desktop.
  const threads = Number(process.env.DSH_MODEL_THREADS) || 4
  const sessionOptions = {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    ...(options.sessionOptions ?? {}),
  }
  const tokenizerConfig = JSON.parse(fs.readFileSync(paths.tokenizerConfig, 'utf8'))
  const tokenizer = new Tokenizer(JSON.parse(fs.readFileSync(paths.tokenizer, 'utf8')), tokenizerConfig)
  const session = await ort.InferenceSession.create(paths.model, sessionOptions)
  const outputName = session.outputNames[0]

  async function embed(text, kind = 'passage') {
    const ids = encodeIds(tokenizer, text, kind, maxTokens)
    const size = ids.length
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, size]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, size]),
    }
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(size), [1, size])
    }
    const output = await session.run(feeds)
    return meanPoolNormalize(output[outputName])
  }

  function truncate(text, limit = 384) {
    const value = typeof text === 'string' ? text : ''
    const ids = tokenizer.encode(value).ids
    if (ids.length <= limit) return { text: value, tokens: ids.length }
    const sliced = ids.slice(0, limit)
    return { text: tokenizer.decode(sliced), tokens: sliced.length }
  }

  return {
    modelId: MODEL_ID,
    dimensions: DIMENSIONS,
    maxTokens,
    paths,
    tokenCount(text, kind = 'passage') {
      return encodeIds(tokenizer, text, kind, maxTokens).length
    },
    truncate,
    embed,
    embedQuery(text) {
      return embed(text, 'query')
    },
    embedPassage(text) {
      return embed(text, 'passage')
    },
    async embedMany(texts, kind = 'passage') {
      const vectors = []
      for (const text of texts) vectors.push(await embed(text, kind))
      return vectors
    },
    async dispose() {
      try {
        await session.release?.()
      } catch {}
    },
  }
}

/** Small self-check used by `verify.js` and the pull command. */
export async function verifyModel({ documents = 50 } = {}) {
  const started = Date.now()
  const embedder = await createEmbedder()
  const loadMs = Date.now() - started
  const query = await embedder.embedQuery('任务完成时给我发微信通知')
  const wecom = await embedder.embedPassage('Notifies via WeCom webhook when a turn ends; supports custom templates.')
  const pdf = await embedder.embedPassage('Renders PDF files into images for OCR analysis.')
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)
  const samples = Array.from({ length: documents }, (_, index) =>
    `Plugin number ${index} adds a sidebar widget and exposes a tool for file conversion.`)
  const startedDocs = Date.now()
  for (const sample of samples) await embedder.embedPassage(sample)
  const docsMs = Date.now() - startedDocs
  const queryTokens = embedder.tokenCount('任务完成时给我发微信通知', 'query')
  await embedder.dispose()
  const manifest = readManifest()
  return {
    model: MODEL_ID,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    manifest,
    loadMs,
    queryTokens,
    dimensions: query.length,
    simWecom: Number(dot(query, wecom).toFixed(4)),
    simPdf: Number(dot(query, pdf).toFixed(4)),
    documents,
    docsMs,
    msPerDoc: Number((docsMs / documents).toFixed(1)),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  }
}
