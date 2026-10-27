#!/usr/bin/env node
/**
 * Command line entry for building, inspecting, and querying the local index.
 * This is a standalone package bin; DSH has no plugin-contributed `dsh`
 * subcommand, so `dsh plugin add` installs the package and this bin runs
 * beside it.
 */
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { defaultIndexDir } from './paths.js'
import { buildIndex } from './build.js'
import {
  isLockStale, readBuildLog, readLock, readManifest, readRecords,
} from './store.js'
import { createSearcher, explainWithReadme, search } from './search.js'
import { textReport } from './report.js'
import { PRESETS } from './filters.js'
import { detectRuntimeVersion } from './compat.js'

const USAGE = `dsh-plugin-discover — local DSH plugin index

Usage:
  dsh-plugin-discover build   [--index-dir <dir>] [--json] [--quiet]
  dsh-plugin-discover status  [--index-dir <dir>] [--json]
  dsh-plugin-discover search  <query> [--alt <text>]... [--limit <n>]
                              [--preset strict|balanced|loose|off]
                              [--min-verification <0-5>] [--explain <id>] [--readme] [--json]
                              [--readme-max-chars <n>]
  dsh-plugin-discover model status [--index-dir <dir>] [--profile <name>] [--json]
  dsh-plugin-discover model pull   [--spec <spec>] [--profile <name>]
                                   [--index-dir <dir>] [--dry-run] [--no-verify] [--json]

Options:
  --index-dir <dir>   Override the index directory. Must match the plugin's indexDir.
  --alt <text>        A query rewrite; repeat up to three times.
  --json              Print machine-readable JSON.
  --quiet             Suppress build progress.
  --readme            With --explain: also fetch that plugin's README as raw Markdown.
  --readme-max-chars <n>
                      Character cap for --readme output (default 200000).
  --spec <spec>       Model package spec for model pull, such as
                      link:D:\\path\\to\\model or file:D:\\path\\model.tgz.
  --profile <name>    DSH profile for model pull (default: DSH_PROFILE or web).
  --dry-run           Print the model install command without running it.
  --no-verify         Skip SHA-256 verification of the model package.
  -h, --help          Show this help.

Default index directory: %LOCALAPPDATA%\\dsh-plugin-discover (Windows),
~/Library/Caches/dsh-plugin-discover (macOS),
\${XDG_CACHE_HOME:-~/.cache}/dsh-plugin-discover (Linux).

The optional model package is not downloaded automatically. \`model pull\`
installs it explicitly; the tool never installs anything.
`

function resolveIndexDir(value) {
  const configured = typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : (process.env.DSH_PLUGIN_DISCOVER_INDEX_DIR || defaultIndexDir())
  return configured
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function printStatus(indexDir, json) {
  const current = readManifest(indexDir)
  const lock = readLock(indexDir)
  const activeLock = lock && !isLockStale(lock) ? lock : null
  const recordsSize = (() => {
    try { return statSync(join(indexDir, current?.name ?? '', 'records.json')).size } catch { return null }
  })()
  const value = {
    indexDir,
    hasIndex: current !== null,
    current: current?.name ?? null,
    builtAt: current?.manifest?.builtAt ?? null,
    generatedAt: current?.manifest?.sources?.dshSo?.generatedAt ?? null,
    cards: current?.manifest?.stats?.cards ?? 0,
    sources: current?.manifest?.sources ?? null,
    stats: current?.manifest?.stats ?? null,
    recordsBytes: recordsSize,
    building: activeLock !== null,
    lock: activeLock,
    lastBuildLog: readBuildLog(indexDir).slice(-2000),
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  const lines = [
    `索引目录：${indexDir}`,
    `当前索引：${current?.name ?? '（无）'}`,
    `卡片数量：${value.cards}`,
    `数据截至：${value.generatedAt ? String(value.generatedAt).slice(0, 10) : '（未知）'}`,
    `建库时间：${value.builtAt ?? '（无）'}`,
    `记录文件：${recordsSize === null ? '（无）' : formatBytes(recordsSize)}`,
    `来源：${value.sources ? Object.entries(value.sources).filter(([, source]) => source?.ok).map(([name]) => name).join(', ') : '（无）'}`,
    `建库中：${value.building ? `是（PID ${activeLock?.pid ?? '?'}）` : '否'}`,
    `DSH 版本：${detectRuntimeVersion() ?? '（未检测到）'}`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printReport(value, current) {
  const report = textReport(value, { manifest: current?.manifest ?? null })
  process.stdout.write(`${report}\n`)
}

function profileDirOf(profile) {
  const name = profile || process.env.DSH_PROFILE || 'web'
  if (process.env.DSH_PROFILE_DIR && (!process.env.DSH_PROFILE || process.env.DSH_PROFILE === name)) {
    return { profile: name, dir: process.env.DSH_PROFILE_DIR }
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return { profile: name, dir: join(home, 'profiles', name) }
}

function resolveInstalledModel(profileDir) {
  const manifestFile = join(profileDir, 'package.json')
  if (!existsSync(manifestFile)) return null
  try {
    const require = createRequire(manifestFile)
    const manifestPath = require.resolve('dsh-plugin-discover-model/manifest.json')
    const packageDir = dirname(manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    return { packageDir, version: pkg.version, manifest }
  } catch {
    return null
  }
}

function readModelPointer(indexDir) {
  try {
    const value = JSON.parse(readFileSync(join(indexDir, 'model.json'), 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function runtimeDependency(packageDir, name) {
  try {
    const require = createRequire(join(packageDir, 'package.json'))
    const entry = require.resolve(name)
    let version = null
    try {
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
      version = pkg.version ?? null
    } catch {}
    return { installed: true, entry, version }
  } catch {
    return { installed: false }
  }
}

function modelStatusValue({ profile, profileDir, indexDir }) {
  const installed = resolveInstalledModel(profileDir)
  const pointer = readModelPointer(indexDir)
  const value = {
    profile,
    profileDir,
    indexDir,
    pointerPath: join(indexDir, 'model.json'),
    installed: installed !== null,
    packageDir: installed?.packageDir ?? null,
    version: installed?.version ?? null,
    manifest: installed?.manifest ?? null,
    runtime: installed
      ? {
          tokenizer: runtimeDependency(installed.packageDir, '@huggingface/tokenizers'),
          onnxruntime: runtimeDependency(installed.packageDir, 'onnxruntime-node'),
        }
      : null,
    pointer,
    pointerMatches: Boolean(
      installed && pointer && typeof pointer.packageDir === 'string'
      && pointer.packageDir.toLowerCase() === installed.packageDir.toLowerCase()),
  }
  if (installed) {
    const modelBytes = installed.manifest?.files?.['model_quantized.onnx']?.bytes ?? null
    const tokenizerBytes = installed.manifest?.files?.['tokenizer.json']?.bytes ?? null
    value.modelBytes = modelBytes
    value.tokenizerBytes = tokenizerBytes
  }
  return value
}

function printModelStatus(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }
  const lines = [
    `模型包：${value.installed ? '已安装' : '未安装'}`,
    `profile：${value.profile}（${value.profileDir}）`,
    `索引目录：${value.indexDir}`,
    `指针文件：${value.pointerPath}${value.pointerMatches ? '（已记录）' : '（未记录或与安装目录不一致）'}`,
  ]
  if (value.installed) {
    lines.push(`包目录：${value.packageDir}`)
    lines.push(`版本：${value.version}`)
    lines.push(`模型：${value.modelBytes ? formatBytes(value.modelBytes) : '（manifest 无大小）'}`)
    lines.push(`tokenizer：${value.tokenizerBytes ? formatBytes(value.tokenizerBytes) : '（manifest 无大小）'}`)
    lines.push(`tokenizer 运行时：${value.runtime.tokenizer.installed ? '已安装' : '缺失'}`)
    lines.push(`ONNX 运行时：${value.runtime.onnxruntime.installed ? '已安装' : '缺失'}`)
    if (value.pointerMatches) lines.push(`安装时间：${value.pointer.installedAt ?? '（未记录）'}`)
  } else {
    lines.push('拉取：dsh-plugin-discover model pull --spec <模型包 spec>')
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function sha256File(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyModelFiles(packageDir, manifest, verifyHashes) {
  const errors = []
  const files = manifest?.files && typeof manifest.files === 'object' ? manifest.files : {}
  for (const [name, expected] of Object.entries(files)) {
    const file = join(packageDir, name)
    if (!existsSync(file)) {
      errors.push(`${name}: missing`)
      continue
    }
    const size = statSync(file).size
    if (Number.isFinite(expected.bytes) && size !== expected.bytes) {
      errors.push(`${name}: size ${size} != ${expected.bytes}`)
    }
    if (verifyHashes && typeof expected.sha256 === 'string') {
      const hash = await sha256File(file)
      if (hash.toLowerCase() !== expected.sha256.toLowerCase()) {
        errors.push(`${name}: sha256 mismatch`)
      }
    }
  }
  return { ok: errors.length === 0, errors, hashes: verifyHashes, files: Object.keys(files).length }
}

function installModelPackage(spec, profileDir, dryRun) {
  if (!/^[^\s;&|<>^"]+$/.test(spec)) {
    throw new Error('模型包 spec 不能包含空白或 shell 元字符')
  }
  if (dryRun) return { dryRun: true, display: `pnpm add ${spec}` }
  const command = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `pnpm add ${spec}`]]
    : ['pnpm', ['add', spec]]
  // Stream pnpm output so a slow download still shows progress, and keep the
  // tail so the caller can tell a skipped build script from a real failure.
  return new Promise(resolve => {
    let output = ''
    const collect = chunk => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-16384)
    }
    let child
    try {
      child = spawn(command[0], command[1], {
        cwd: profileDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ dryRun: false, status: null, signal: null, error: String(error.message ?? error), output })
      return
    }
    child.stdout.on('data', chunk => { collect(chunk); process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { collect(chunk); process.stderr.write(chunk) })
    child.on('error', error => resolve({
      dryRun: false, status: null, signal: null, error: String(error.message ?? error), output,
    }))
    child.on('close', (status, signal) => resolve({ dryRun: false, status, signal, error: null, output }))
  })
}

/** pnpm exits non-zero when it skips a dependency build script; that is expected. */
function isIgnoredBuildsFailure(install) {
  return /ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(install.output ?? '')
}

function buildModelPointer(packageDir, version, manifest) {
  return {
    format: 1,
    package: 'dsh-plugin-discover-model',
    version,
    packageDir,
    server: join(packageDir, 'server.js'),
    manifest: join(packageDir, 'manifest.json'),
    model: join(packageDir, 'model_quantized.onnx'),
    tokenizer: join(packageDir, 'tokenizer.json'),
    dimensions: manifest?.dimensions ?? null,
    maxTokens: manifest?.maxTokens ?? null,
    installedAt: new Date().toISOString(),
  }
}

function writeModelPointer(indexDir, pointer) {
  mkdirSync(indexDir, { recursive: true })
  const file = join(indexDir, 'model.json')
  writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`)
  return file
}


async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE)
    return 0
  }

  if (command === 'build') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        'index-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    const indexDir = resolveIndexDir(values['index-dir'])
    const result = await buildIndex({
      indexDir,
      onProgress: message => { if (!values.quiet) process.stderr.write(`${message}\n`) },
    })
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else if (result.busy) process.stdout.write(`跳过：另一个建库进程正在运行（PID ${result.lock?.pid ?? '?'}）\n`)
    else {
      process.stdout.write(`索引已发布：${result.name}\n`)
      process.stdout.write(`卡片：${result.stats.cards} · 数据截至：${String(result.manifest.sources.dshSo.generatedAt).slice(0, 10)}\n`)
    }
    return result.ok || result.busy ? 0 : 1
  }

  if (command === 'status') {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: {
        'index-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    printStatus(resolveIndexDir(values['index-dir']), values.json)
    return 0
  }

  if (command === 'model') {
    const sub = argv[1]
    if (sub !== 'status' && sub !== 'pull') {
      process.stderr.write('usage: dsh-plugin-discover model status|pull [options]\n')
      return 2
    }
    const { values } = parseArgs({
      args: argv.slice(2),
      options: {
        'index-dir': { type: 'string' },
        profile: { type: 'string' },
        spec: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'no-verify': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    const indexDir = resolveIndexDir(values['index-dir'])
    const { profile, dir } = profileDirOf(values.profile)

    if (sub === 'status') {
      printModelStatus(modelStatusValue({ profile, profileDir: dir, indexDir }), values.json)
      return 0
    }

    const spec = values.spec
      || process.env.DSH_PLUGIN_DISCOVER_MODEL_SPEC
      || 'dsh-plugin-discover-model@0.1.0'
    if (!existsSync(dir)) {
      process.stderr.write(`profile 目录不存在：${dir}\n`)
      return 1
    }
    if (values['dry-run']) {
      try {
        const dry = installModelPackage(spec, dir, true)
        if (values.json) process.stdout.write(`${JSON.stringify({ spec, profile, profileDir: dir, ...dry }, null, 2)}\n`)
        else process.stdout.write(`cd ${dir}\n${dry.display}\n`)
        return 0
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
    }

    let install
    try {
      install = await installModelPackage(spec, dir, false)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    if (install.error) {
      process.stderr.write(`模型包安装失败：${install.error}\n`)
      return 1
    }
    if (install.status !== 0 && !isIgnoredBuildsFailure(install)) {
      const previous = resolveInstalledModel(dir)
      const reason = install.status === null ? 'pnpm 无法启动' : `pnpm exit ${install.status}`
      process.stderr.write(`模型包安装失败（${reason}）：${spec}\n`)
      if (previous) process.stderr.write(`已安装的 ${previous.version} 仍可用，但本次没有更新。\n`)
      return 1
    }
    const installed = resolveInstalledModel(dir)
    if (!installed) {
      process.stderr.write(`模型包安装后仍无法解析（pnpm exit ${install.status}）；检查 pnpm 输出与 profile 依赖。\n`)
      return 1
    }
    const verification = await verifyModelFiles(
      installed.packageDir,
      installed.manifest,
      !values['no-verify'],
    )
    if (!verification.ok) {
      process.stderr.write(`模型包校验失败：\n- ${verification.errors.join('\n- ')}\n`)
      return 1
    }
    // pnpm exits non-zero when it ignores a dependency's build script. The
    // design deliberately does not bypass that approval; the prebuilt CPU
    // binary works, so a verified package is still a success with a warning.
    const warning = install.status !== 0
      ? `pnpm exit ${install.status}（ERR_PNPM_IGNORED_BUILDS）：onnxruntime-node 的 postinstall 被跳过，预编译二进制仍可用。`
      : null
    const pointer = buildModelPointer(installed.packageDir, installed.version, installed.manifest)
    let pointerPath
    try {
      pointerPath = writeModelPointer(indexDir, pointer)
    } catch (error) {
      process.stderr.write(`写入 model.json 失败：${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
    const status = modelStatusValue({ profile, profileDir: dir, indexDir })
    if (values.json) {
      process.stdout.write(`${JSON.stringify({
        spec,
        profile,
        profileDir: dir,
        install,
        warning,
        verification,
        pointerPath,
        pointer,
        status,
      }, null, 2)}\n`)
    } else {
      process.stdout.write(`模型包已安装：${installed.packageDir}\n`)
      process.stdout.write(`校验：${verification.files} 个文件${verification.hashes ? '，SHA-256 通过' : '（仅大小）'}\n`)
      if (warning) process.stdout.write(`注意：${warning}\n`)
      process.stdout.write(`已记录：${pointerPath}\n`)
      printModelStatus(status, false)
    }
    return 0
  }

  if (command === 'search') {
    const { values, positionals } = parseArgs({
      args: argv.slice(1),
      options: {
        'index-dir': { type: 'string' },
        alt: { type: 'string', multiple: true, default: [] },
        limit: { type: 'string', default: '10' },
        preset: { type: 'string', default: 'balanced' },
        'min-verification': { type: 'string', default: '4' },
        explain: { type: 'string' },
        readme: { type: 'boolean', default: false },
        'readme-max-chars': { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    })
    const query = positionals.join(' ').trim()
    if (query === '' && !values.explain) {
      process.stderr.write('search requires a query (or --explain <id>)\n')
      return 2
    }
    if (values.readme && !values.explain) {
      process.stderr.write('--readme requires --explain <id>\n')
      return 2
    }
    const charCap = Number(values['readme-max-chars'])
    const indexDir = resolveIndexDir(values['index-dir'])
    const records = readRecords(indexDir)
    if (!records) {
      process.stderr.write(`没有可用索引：${indexDir}\n先执行：dsh-plugin-discover build\n`)
      return 1
    }
    const manifest = readManifest(indexDir)
    const preset = PRESETS.includes(values.preset) ? values.preset : 'balanced'
    const limit = Math.min(20, Math.max(1, Number(values.limit) || 10))
    const searcher = createSearcher(records.records, { runtimeVersion: detectRuntimeVersion() })
    const value = values.explain
      ? await explainWithReadme(searcher, values.explain, {
          query,
          readme: values.readme,
          readmeMaxChars: Number.isFinite(charCap) && charCap > 0 ? charCap : undefined,
        })
      : await search(searcher, {
          query,
          queryAlts: values.alt,
          limit,
          preset,
          minVerificationLevel: Number(values['min-verification']) || 0,
          indexDir,
        })
    if (values.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    else printReport(value, manifest)
    return 0
  }

  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
  return 2
}

const code = await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  return 1
})
process.exitCode = code
