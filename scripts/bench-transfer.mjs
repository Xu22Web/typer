#!/usr/bin/env node
/**
 * 传输基准 / 端到端自检（不进入默认 CI）。
 *
 * 对**任意文件**回答三个问题：
 *   1. 要打多少个字符（这是耗时的唯一决定因素）；
 *   2. 各档位与各字符档分别要多久；
 *   3. 接收端拿这些帧能不能逐字节还原（`--emit` + 接收端校验）。
 *
 * 用法：
 *   node scripts/bench-transfer.mjs "D:\path\to\file"
 *   node scripts/bench-transfer.mjs "D:\path\to\file" --alphabet ascii32 --chunk 16384 --emit frames.txt
 *
 * 只做本地计算，不产生任何按键。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @description 读取 `--flag value` 形式的参数
 * @param argv 参数列表
 * @returns 参数表
 */
function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      out.file = arg
      continue
    }
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) out[key] = true
    else {
      out[key] = value
      index += 1
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error(
    '用法：node scripts/bench-transfer.mjs <文件> [--alphabet ascii32|ascii64|hex] [--chunk 16384] [--emit <frames.txt>] [--verify]'
  )
  process.exit(4)
}

const path = args.file
const size = statSync(path).size

// 就地打包主进程的准备实现，避免另写一份估算导致口径漂移
const outdir = join(root, 'out', 'bench')
mkdirSync(outdir, { recursive: true })
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: {
    prepare: join(root, 'src', 'main', 'transfer', 'prepare.ts'),
    shared: join(root, 'src', 'shared', 'transfer', 'transfer.ts')
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'error',
  alias: {
    '@main': join(root, 'src', 'main'),
    '@shared': join(root, 'src', 'shared')
  }
})

const { prepareTransfer } = await import(pathToFileURL(join(outdir, 'prepare.mjs')).href)
const { CHUNK_PRESETS } = await import(pathToFileURL(join(outdir, 'shared.mjs')).href)

const chunkPreset =
  CHUNK_PRESETS.find((preset) => preset.id === (args.preset ?? 'default')) ?? CHUNK_PRESETS[1]
const chunkBytes = args.chunk ? Number(args.chunk) : chunkPreset.chunkBytes
const maxFrameChars = args.chunk ? Number(args.chunk) * 4 : chunkPreset.maxFrameChars
const alphaList = args.alphabet ? [args.alphabet] : ['ascii32', 'ascii64', 'hex']
const quality = args.quality === undefined ? 9 : Number(args.quality)
const compression = args.compression ?? 'auto'

console.log(`文件：${path}`)
console.log(`大小：${size} 字节（${(size / 1024 / 1024).toFixed(2)} MiB）`)

/** 人类可读时长 */
function human(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds.toFixed(0)} 秒`
  const minutes = seconds / 60
  if (minutes < 90) return `${minutes.toFixed(0)} 分`
  return `${(minutes / 60).toFixed(1)} 小时`
}

/** 各档位的每秒字符数（turbo 取实测值，真实速度仍受目标端消化能力影响） */
const SPEEDS = [
  { label: 'safe 446 cps', cps: 446 },
  { label: 'fast 446 cps', cps: 446 },
  { label: 'turbo 700 cps', cps: 700 }
]

const rows = []
for (const alphabet of alphaList) {
  const job = await prepareTransfer({
    path,
    options: {
      alphabet,
      compression,
      quality,
      chunkBytes,
      maxFrameChars,
      mode: args.mode ?? 'term'
    }
  })
  const summary = job.summary
  rows.push({ alphabet, summary })
  await job.dispose()
}

const head = '字符档    压缩      线上字节   分片   字符数        字符/字节  '
console.log(
  `\n分片：${chunkBytes} 字节（帧长上限 ${maxFrameChars}），压缩：${compression} q${quality}\n`
)
console.log(head)
for (const row of rows) {
  const s = row.summary
  console.log(
    `${row.alphabet.padEnd(9)} ${String(s.compression).padEnd(9)} ${String(s.wireBytes).padStart(10)} ` +
      `${String(s.total).padStart(5)} ${String(s.frameChars).padStart(13)} ` +
      `${(s.frameChars / Math.max(1, s.size)).toFixed(3).padStart(10)}`
  )
}

console.log('\n预计耗时（按字符数 ÷ 每秒字符数）：')
for (const row of rows) {
  const s = row.summary
  const parts = SPEEDS.map((speed) => `${speed.label}=${human((s.frameChars / speed.cps) * 1000)}`)
  console.log(`  ${row.alphabet.padEnd(9)} ${parts.join('  ')}`)
}
console.log(`\n压缩结论：${rows[0].summary.compressionNote}`)
console.log(`准备耗时：${rows[0].summary.prepareMs} ms`)

if (args.emit) {
  // 按默认（或指定）字符档把所有帧写成文本，供接收端离线校验
  const target = rows[rows.length - 1]
  const job = await prepareTransfer({
    path,
    options: {
      alphabet: target.alphabet,
      compression,
      quality,
      chunkBytes,
      maxFrameChars,
      mode: args.mode ?? 'term'
    }
  })
  const lines = [job.beginFrame()]
  for (let index = 0; index < job.summary.total; index++) lines.push(await job.renderFrame(index))
  lines.push(job.endFrame())
  writeFileSync(args.emit, lines.join('\r\n') + '\r\n')
  await job.dispose()
  console.log(`\n已写出 ${lines.length} 帧 → ${args.emit}`)

  if (args.verify) {
    const work = join(outdir, 'verify')
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'tools', 'typer-recv.mjs'),
        '--in',
        args.emit,
        '-o',
        join(work, 'out.bin'),
        '-d',
        join(work, 'parts'),
        '--quiet'
      ],
      { encoding: 'utf8' }
    )
    const expected = createHash('sha256').update(readFileSync(path)).digest('hex')
    let actual = '(missing)'
    try {
      actual = createHash('sha256')
        .update(readFileSync(join(work, 'out.bin')))
        .digest('hex')
    } catch {
      // 未生成
    }
    console.log(`\n接收端退出码：${result.status}`)
    if (result.stdout.trim()) console.log(result.stdout.trim())
    if (result.stderr.trim()) console.log(result.stderr.trim())
    console.log(`源 SHA-256 ：${expected}`)
    console.log(`产物 SHA-256：${actual}`)
    console.log(expected === actual ? '✓ 逐字节一致' : '✗ 不一致')
    process.exit(expected === actual ? 0 : 3)
  }
}
