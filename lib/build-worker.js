#!/usr/bin/env node
/**
 * Background build entry. The Host spawns this file with the index directory;
 * progress and failures go to build.log so no stdout pipe can block us.
 */
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs'
import { buildIndex } from './build.js'
import { buildLogPath } from './paths.js'

const indexDir = process.argv[2]
if (!indexDir) {
  process.stderr.write('usage: build-worker.js <index-dir>\n')
  process.exit(2)
}
mkdirSync(indexDir, { recursive: true })
try {
  if (statSync(buildLogPath(indexDir)).size > 2 * 1024 * 1024) truncateSync(buildLogPath(indexDir), 0)
} catch {}

function log(message) {
  try {
    appendFileSync(buildLogPath(indexDir), `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

try {
  const result = await buildIndex({ indexDir, onProgress: log })
  log(result.busy ? '跳过：另一个建库进程正在运行' : `完成：${result.stats.cards} 张卡片`)
} catch (error) {
  log(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exitCode = 1
}
