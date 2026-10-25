#!/usr/bin/env node
/** Standalone verification for the optional model package. */
import { verifyModel } from './index.js'

const documentsIndex = process.argv.indexOf('--documents')
const documents = documentsIndex >= 0 ? Number(process.argv[documentsIndex + 1]) || 50 : 50
const json = process.argv.includes('--json')

try {
  const result = await verifyModel({ documents })
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write([
      `model: ${result.model}`,
      `platform: ${result.platform} / node ${result.node}`,
      `load: ${result.loadMs} ms · dimensions ${result.dimensions} · query tokens ${result.queryTokens}`,
      `sim(wecom)=${result.simWecom} · sim(pdf)=${result.simPdf}`,
      `${result.documents} docs: ${result.docsMs} ms (${result.msPerDoc} ms/doc) · RSS ${result.rssMb} MB`,
    ].join('\n') + '\n')
  }
  process.exitCode = result.dimensions === 384 ? 0 : 1
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exitCode = 1
}
