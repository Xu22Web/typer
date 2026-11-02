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
    '用法：node scripts/bench-transfer.mjs <文件> [--alphabet ascii32|ascii64|b47|hex] [--chunk 16384] [--emit <frames.txt>] [--verify]'
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
const alphaList = args.alphabet ? [args.alphabet] : ['b47', 'ascii32', 'ascii64', 'hex']
const quality = args.quality === undefined ? 9 : Number(args.quality)
// 47 进制用到了编辑器会自动更正的字符，只能在终端目标端下跑
const mode = args.mode ?? 'term'
const compression = args.compression ?? 'auto'

console.log(`文件：${path}`)
console.log(`大小：${size} 字节（${(size / 1024 / 1024).toFixed(2)} MiB）`)

/** 人类可读时长 */
function human(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(0)} 秒`
  const minutes = seconds / 60
  if (minutes < 90) return `${Math.floor(minutes)} 分 ${Math.round(seconds % 60)} 秒`
  return `${(minutes / 60).toFixed(1)} 小时`
}

/** 各档位的每秒字符数（turbo 取实测值，真实速度仍受目标端消化能力影响） */
const SPEEDS = [
  { label: 'safe 446 cps', cps: 446 },
  { label: 'fast 446 cps', cps: 446 },
  { label: 'turbo 700 cps', cps: 700 }
]

/**
 * 需要 Shift 的字符：`ascii64` 里的大写字母与 `_`（US 布局）。
 * `ascii32` / `b47` / `hex` 按构造就全是无需 Shift 的键。
 */
const SHIFT_CHARS = /[A-Z_]/
/** 一次修饰键切换的代价：宿主 lead 15ms + tail 10ms（连续同修饰键保持按住，只算一次） */
const SHIFT_SWITCH_MS = 25

/**
 * @description 统计载荷里的 Shift 字符比例与“修饰键切换”次数
 * @param job 已准备好的传输任务
 * @returns 字符占比与切换次数
 */
async function measureShift(job) {
  let previous = false
  let switches = 0
  let total = 0
  let hit = 0
  for (let index = 0; index < job.summary.total; index++) {
    const payload = (await job.renderFrame(index)).split(' ').pop() ?? ''
    for (const char of payload) {
      const need = SHIFT_CHARS.test(char)
      total += 1
      if (need) hit += 1
      if (need !== previous) {
        switches += 1
        previous = need
      }
    }
  }
  return { share: total === 0 ? 0 : hit / total, switches }
}

const rows = []
for (const alphabet of alphaList) {
  if (alphabet === 'b47' && mode !== 'term') {
    console.log(`跳过 ${alphabet}：47 进制只能用于终端目标端`)
    continue
  }
  const job = await prepareTransfer({
    path,
    options: {
      alphabet,
      compression,
      quality,
      chunkBytes,
      maxFrameChars,
      mode
    }
  })
  const summary = job.summary
  const shift = args['no-shift'] ? { share: 0, switches: 0 } : await measureShift(job)
  rows.push({ alphabet, summary, shift })
  await job.dispose()
}

const baseline = rows.find((row) => row.alphabet === 'ascii32') ?? rows[0]
const head = '字符档    线上字节   字符数      字符/字节  相对 5 位  Shift 占比·切换'
console.log(
  `\n分片：${chunkBytes} 字节（帧长上限 ${maxFrameChars}），压缩：${compression}，` +
    `质量：请求 q${quality} → 实际 q${rows[0].summary.quality}\n`
)
console.log(head)
for (const row of rows) {
  const s = row.summary
  const relative = ((s.frameChars / baseline.summary.frameChars) * 100).toFixed(1)
  const shiftCell =
    row.shift.switches === 0
      ? '-'
      : `${(row.shift.share * 100).toFixed(0)}% · ${row.shift.switches} 次`
  console.log(
    `${row.alphabet.padEnd(9)} ${String(s.wireBytes).padStart(10)} ` +
      `${String(s.frameChars).padStart(10)}  ${(s.frameChars / Math.max(1, s.size)).toFixed(3).padStart(8)} ` +
      `${`${relative}%`.padStart(9)}  ${shiftCell}`
  )
}

console.log('\n预计耗时（字符数 ÷ 每秒字符数，外加修饰键切换）：')
for (const row of rows) {
  const s = row.summary
  const extra = row.shift.switches * SHIFT_SWITCH_MS
  console.log(`  ${row.alphabet}`)
  for (const speed of SPEEDS) {
    const typed = (s.frameChars / speed.cps) * 1000
    const detail = extra === 0 ? '' : `（字符 ${human(typed)} + 切换 ${human(extra)}）`
    console.log(`    ${speed.label.padEnd(14)} 总计 ${human(typed + extra)}${detail}`)
  }
}
console.log(`\n压缩结论：${rows[0].summary.compressionNote}`)
console.log(`准备耗时：${rows[0].summary.prepareMs} ms`)

if (args.emit) {
  // 默认用终端最优档（b47）落帧，顺带验证新编码分支；显式 --alphabet 时按指定的来
  const targetAlphabet = args.alphabet ?? 'b47'
  const job = await prepareTransfer({
    path,
    options: {
      alphabet: targetAlphabet,
      compression,
      quality,
      chunkBytes,
      maxFrameChars,
      mode: targetAlphabet === 'b47' ? 'term' : mode
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
