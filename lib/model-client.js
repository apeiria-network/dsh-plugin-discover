/**
 * Client for the optional model package's line-delimited JSON server. The
 * server owns the ~500 MB ONNX/tokenizer RSS; the Host only holds vectors.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** The optional model package is not installed or its server is missing. */
export class ModelUnavailableError extends Error {
  constructor(message = 'model package is not installed') {
    super(message)
    this.name = 'ModelUnavailableError'
    this.code = 'MODEL_UNAVAILABLE'
  }
}

/** Resolve the server entry through the index pointer, then the profile. */
export function resolveModelServer(indexDir) {
  try {
    const pointer = JSON.parse(readFileSync(join(indexDir, 'model.json'), 'utf8'))
    if (pointer && typeof pointer.server === 'string' && existsSync(pointer.server)) return pointer.server
  } catch {}
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) {
    try {
      const require = createRequire(join(profileDir, 'package.json'))
      const server = require.resolve('dsh-plugin-discover-model/server.js')
      if (existsSync(server)) return server
    } catch {}
  }
  return null
}

/** Spawned model server with request/response correlation and idle respawn. */
export class ModelClient {
  constructor(serverPath, { timeoutMs = 60_000 } = {}) {
    this.serverPath = serverPath
    this.timeoutMs = timeoutMs
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.stderr = ''
    this.closed = false
    this.embeddedDocs = 0
    // Recycling is an escape hatch for pathological environments, not the
    // default: the model is capped at four ONNX threads instead of all cores.
    this.recycleDocs = Number(process.env.DSH_MODEL_RECYCLE_DOCS) || 0
  }

  /** Stop this child after a bounded number of documents; the next request respawns. */
  recycle() {
    this.failAll(new ModelUnavailableError('model client recycled'))
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    this.embeddedDocs = 0
  }

  start() {
    if (this.child) return
    if (this.closed) throw new ModelUnavailableError('model client is disposed')
    const env = { ...process.env }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const command = process.env.DSH_PLUGIN_DISCOVER_NODE || process.execPath
    let child
    try {
      child = spawn(command, [this.serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      })
    } catch (error) {
      throw new ModelUnavailableError(`cannot start model server: ${error.message}`)
    }
    this.child = child
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      const text = line.trim()
      if (text === '') return
      let response
      try {
        response = JSON.parse(text)
      } catch {
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      if (typeof response.error === 'string') pending.reject(new Error(response.error))
      else pending.resolve(response)
    })
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000)
    })
    child.on('error', error => {
      if (this.child !== child) return
      this.failAll(new ModelUnavailableError(`model server error: ${error.message}`))
      this.child = null
    })
    child.on('exit', code => {
      if (this.child !== child) return
      this.failAll(new ModelUnavailableError(
        `model server exited (${code})${this.stderr ? `: ${this.stderr.slice(-500)}` : ''}`,
      ))
      this.child = null
    })
  }

  failAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  request(op, payload, timeoutMs = this.timeoutMs) {
    this.start()
    const id = this.nextId++
    const line = `${JSON.stringify({ id, op, ...payload })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`model server request timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ModelUnavailableError(`cannot write to model server: ${error.message}`))
      }
    })
  }

  async embed(texts, kind = 'passage') {
    if (this.recycleDocs > 0 && this.embeddedDocs >= this.recycleDocs) this.recycle()
    const response = await this.request('embed', { texts, kind }, Math.max(this.timeoutMs, 120_000))
    if (!Array.isArray(response.vectors)) throw new Error('model server returned no vectors')
    this.embeddedDocs += texts.length
    if (this.recycleDocs > 0 && this.embeddedDocs >= this.recycleDocs) this.recycle()
    return response.vectors.map(vector => Float32Array.from(vector))
  }

  async truncate(text, maxTokens = 384) {
    const response = await this.request('truncate', { text, maxTokens })
    return { text: String(response.text ?? ''), tokens: Number(response.tokens ?? 0) }
  }

  dispose() {
    this.closed = true
    this.failAll(new ModelUnavailableError('model client disposed'))
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
  }
}
