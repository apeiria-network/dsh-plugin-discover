#!/usr/bin/env node
/**
 * Line-delimited JSON embedding server. The Host spawns this file so the
 * ~520 MB model RSS lives in a child process, not in the Host process.
 *
 * Request:  {"id":1,"op":"embed","kind":"query","texts":["..."],"maxTokens":512}
 * Response: {"id":1,"model":"multilingual-e5-small","dimensions":384,"vectors":[[...]]}
 * Info:     {"id":2,"op":"info"}
 */
import { createInterface } from 'node:readline'
import { createEmbedder, DIMENSIONS, MAX_TOKENS, MODEL_ID, modelPaths, readManifest } from './index.js'

const IDLE_MS = 5 * 60 * 1000
let embedderPromise = null
let idle = null

function armIdle() {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => process.exit(0), IDLE_MS)
  idle.unref?.()
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function getEmbedder() {
  if (!embedderPromise) embedderPromise = createEmbedder()
  return await embedderPromise
}

async function handle(request) {
  const id = request?.id
  if (request?.op === 'info') {
    return {
      id,
      model: MODEL_ID,
      dimensions: DIMENSIONS,
      maxTokens: MAX_TOKENS,
      paths: modelPaths(),
      manifest: readManifest(),
    }
  }
  if (request?.op === 'truncate') {
    const embedder = await getEmbedder()
    const text = typeof request.text === 'string' ? request.text : ''
    const limit = Number.isInteger(request.maxTokens) ? request.maxTokens : 384
    return { id, ...embedder.truncate(text, limit) }
  }
  if (request?.op !== 'embed' || !Array.isArray(request.texts) || request.texts.length === 0) {
    return { id, error: 'expected {"op":"embed","texts":[...]}' }
  }
  if (request.texts.length > 64) return { id, error: 'at most 64 texts per request' }
  const kind = request.kind === 'query' ? 'query' : 'passage'
  const embedder = await getEmbedder()
  const vectors = await embedder.embedMany(request.texts.map(text => String(text)), kind)
  return {
    id,
    model: MODEL_ID,
    dimensions: DIMENSIONS,
    vectors: vectors.map(vector => Array.from(vector)),
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let closed = false
let pending = 0

function settle() {
  pending -= 1
  if (closed && pending === 0) process.exitCode = 0
}

lines.on('line', line => {
  const text = line.trim()
  if (text === '') return
  armIdle()
  let request
  try {
    request = JSON.parse(text)
  } catch (error) {
    write({ error: `bad json: ${error.message}` })
    return
  }
  pending += 1
  handle(request)
    .then(write)
    .catch(error => write({ id: request?.id, error: error instanceof Error ? error.message : String(error) }))
    .finally(settle)
})
lines.on('close', () => {
  closed = true
  if (pending === 0) process.exitCode = 0
})
armIdle()
