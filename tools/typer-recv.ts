/**
 * Typer 文件接收端（线格式 v2）。
 *
 * 设计目标只有一个：在"只能逐字符输入"的链路上尽量少打字符、尽量快，并且**一定不能写坏数据**。
 *
 *   · 载荷是 15 / 6 / 4 比特一个字符的符号流（见 src/main/util/codec.ts），15 位档把字符数压到十六进制的 1/3.75；
 *   · 整文件先压缩再切片（`br`）或直接切片（`none`），每片自带 CRC32，整文件带 SHA-256；
 *   · 传输期间**不打印任何东西**（终端回显经云桌面回传极慢），只有出错那一行才打印，结束时打印一行结果；
 *   · 走 raw 模式并关回显，接收端自己把控制台代码页切到 UTF-8；
 *   · 默认边收边落盘，中断后重跑即可续传；失败只补缺失片。
 *
 * 零第三方依赖，只用 node: 内置模块，Node >= 14 可运行（目标机常见的是 Node 14/16）。
 * 本文件由 `pnpm build:tools` 打成单文件 tools/typer-recv.mjs 后分发。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
// 源码按现代写法写；`stream/promises` 是 Node 15 才有的模块，产物里这条引用由
// build-tools.mjs 的 alias 换成 scripts/node14/stream-promises.mjs（promisify 包装）
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import {
  ERROR_HINTS,
  FrameError,
  MARKERS,
  MAX_LINE_CHARS,
  buildBeginFrame,
  buildDataFrame,
  buildResumeToken,
  crc32Hex,
  decodeSymbols,
  encodeSymbols,
  formatIndexList,
  missingIndexes,
  parseFrame,
  sanitizeLine,
  symbolCount,
  verifyDataFrame,
  type ParsedBeginFrame,
  type ParsedDataFrame,
  type ParsedEndFrame
} from '../src/main/util/frame'

const EXIT = { OK: 0, INCOMPLETE: 2, BAD: 3, USAGE: 4 }
const REPORT_VERSION = 2

const HELP = `Typer 文件接收端 v2（逐片校验 + 断点续传 + 整文件校验）

用法：node typer-recv.mjs [选项]

  -o, --out <path>        输出文件（默认 <分片目录>/<开始帧里的文件名>）
  -d, --dir <path>        分片工作目录（默认 ./.typer-<job>）
      --in <file>         从文件读取帧（默认读标准输入）
      --cooked            强制行缓冲读入（TTY 下默认 raw：不回显、无行宽限制）
      --no-resume         忽略已有分片全部重收（默认：校验通过即跳过）
      --no-overwrite      输出文件已存在时拒绝覆盖
      --report <path>     续传报告 JSON（默认 <dir>/resume.json；写 "-" 关闭）
      --keep-parts        合并成功后保留分片
      --token             缺失时始终打印续传令牌（默认同样打印）
      --probe             只统计收到了什么，不落盘（确认链路能过非 ASCII 字符）
      --stats             结束时打印字符数/字节数与耗时
      --progress <mode>   进度回显：auto（终端下自动，默认）/ on / off
  -q, --quiet             不打印提示（仅保留 #FAIL / #MISS / #DONE / #BAD）
  -v, --verbose           打印逐片处理信息（很吵，仅排障用）
      --selftest          自检编解码、CRC、帧解析
  -h, --help              显示本帮助

退出码：0 成功；2 数据不全；3 校验失败；4 参数/IO 错误
`

interface Options {
  out: string | null
  dir: string | null
  input: string | null
  cooked: boolean
  resume: boolean
  overwrite: boolean
  report: string | null
  keepParts: boolean
  probe: boolean
  stats: boolean
  /** 进度回显：auto = 只有“人坐在终端前面”时开；on / off 强制 */
  progress: 'auto' | 'on' | 'off'
  quiet: boolean
  verbose: boolean
}

/**
 * @description 解析命令行参数（只支持 `--flag value` 形式）
 * @param argv 参数列表
 * @returns 选项
 */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    out: null,
    dir: null,
    input: null,
    cooked: false,
    resume: true,
    overwrite: true,
    report: null,
    keepParts: false,
    probe: false,
    stats: false,
    progress: 'auto',
    quiet: false,
    verbose: false
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`)
      index += 1
      return value
    }
    if (arg === '-o' || arg === '--out') options.out = next()
    else if (arg === '-d' || arg === '--dir') options.dir = next()
    else if (arg === '--in') options.input = next()
    else if (arg === '--report') options.report = next()
    else if (arg === '--cooked') options.cooked = true
    else if (arg === '--no-resume') options.resume = false
    else if (arg === '--no-overwrite') options.overwrite = false
    else if (arg === '--keep-parts') options.keepParts = true
    else if (arg === '--probe') options.probe = true
    else if (arg === '--stats') options.stats = true
    else if (arg === '--progress') {
      const value = next()
      if (value !== 'auto' && value !== 'on' && value !== 'off') {
        throw new Error(`--progress 只接受 auto / on / off（收到 ${value}）`)
      }
      options.progress = value
    } else if (arg === '-q' || arg === '--quiet') options.quiet = true
    else if (arg === '-v' || arg === '--verbose') options.verbose = true
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(HELP)
      process.exit(EXIT.OK)
    } else if (arg === '--selftest') {
      process.exit(runSelfTest())
    } else if (arg === '--token') {
      // 历史参数：现在缺失时一定打印令牌，保留是为了不打断既有习惯
      continue
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`)
  process.exit(EXIT.USAGE)
}

const quiet = options.quiet
const verbose = options.verbose
const startedAt = Date.now()

// ---------------------------------------------------------------------------
// 进度回显
// ---------------------------------------------------------------------------

/**
 * @description 是否需要回显进度。
 *
 * 默认 `auto`：只在“人坐在接收端终端前面”（没给 `--in`）时回显；`--in` 是离线校验/回归测试，
 * 刷进度既没人看也会污染 stdout。`--quiet` 优先级最高。
 * @returns 是否回显
 */
function progressEnabled(): boolean {
  if (quiet) return false
  if (options.progress === 'off') return false
  if (options.progress === 'on') return true
  return options.input === null
}

/** 终端里能不能用 `\r` 原地重绘；不能就只能一行一行打（重定向到日志时） */
const progressInPlace = Boolean(process.stdout.isTTY)

/** 原地重绘的最小间隔（毫秒）：刷得再快也看不见，反而抢终端带宽 */
const PROGRESS_TTY_INTERVAL_MS = 500

/** 非终端（重定向到日志 / 管道）时每行之间的最小间隔（毫秒） */
const PROGRESS_LINE_INTERVAL_MS = 5_000

/**
 * 多久**没有任何输入**才提醒（毫秒）。
 *
 * 参照物是“最后一次收到字节”，不是“最后一次收下一整片”：一个 16 KB 的片在 400 字/秒下
 * 要打三四十秒，用“片”当参照会在这期间反复报“没收到新片”，纯属噪音。
 */
const IDLE_WARN_MS = 10_000

/** 已经提醒过之后，隔多久才允许再提一次（毫秒） */
const IDLE_WARN_REPEAT_MS = 20_000

/** 当前这一帧收了这么久还没收完时，在进度里补一句耗时（毫秒）：让人看出“在收、只是慢” */
const FRAME_SLOW_HINT_MS = 20_000

/** 速率按最近这段时间的增量算（毫秒）：用“从开始到现在的平均值”会把卡顿与恢复都抹平 */
const RATE_WINDOW_MS = 8_000

/** 进度条宽度：终端下宽一些，写进日志时窄一些 */
const BAR_WIDTH_TTY = 20
const BAR_WIDTH_PLAIN = 16

/** ANSI 颜色：只在终端且支持颜色时用（`NO_COLOR` 可关，日志里永远不留转义序列） */
const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  red: '\u001b[31m'
}

/** 终端是否上色：非 TTY（管道 / 重定向到日志）一律不上色，避免日志里混转义序列 */
const colorEnabled =
  Boolean(process.stdout.isTTY) && process.stdout.hasColors?.(16) === true && !process.env.NO_COLOR

/** 匹配 ANSI 颜色序列（算可见宽度、补空格前要剥掉） */
// eslint-disable-next-line no-control-regex -- 要匹配的就是 ESC 序列本身
const ANSI_SEQUENCE = /\u001b\[[0-9;]*m/g

/** 进度行是否还停在终端最后一行（后续输出前要先换行） */
let progressDrawn = false
/** 上一次画出的**可见宽度**：原地重绘时用来盖掉短行残留 */
let progressLastWidth = 0
let lastProgressAt = 0
/** 最近一次收到任何输入的时刻（毫秒）：判断“上游还在打字吗” */
let lastInputAt = 0
/** 最近一次收下一整片的时刻（毫秒）：算“这一片收了多久” */
let lastShardAt = 0
/** 最近一次“没有任何输入”提醒的时刻 */
let lastIdleWarnAt = 0
/** 合并阶段进度（-1 表示不在合并） */
let mergeDone = -1
let mergeTotal = 0
let mergeStartedAt = 0
/** 速率采样：`{ 时刻, 已收文件字节 }`，只保留最近 RATE_WINDOW_MS */
const rateSamples: Array<{ at: number; bytes: number }> = []
/** 切分器里还没成帧的半行：用来显示“当前这一片收到哪了” */
let pendingFrameText = ''

/** @description 给文本套上颜色（不上色时原样返回） */
function paint(text: string, color: string): string {
  return colorEnabled ? `${color}${text}${ANSI.reset}` : text
}

/** @description 可见宽度：剥掉颜色序列后的字符数 */
function visibleWidth(text: string): number {
  return text.replace(ANSI_SEQUENCE, '').length
}

/**
 * @description 进度条：终端里用实心方块，写进日志时退回 ASCII（不挑字体）
 * @param ratio 0~1
 * @param width 宽度（字符数）
 * @returns 形如 `████████░░░░░░░░░░░░`
 */
function renderBar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  const full = progressInPlace ? '\u2588' : '#'
  const empty = progressInPlace ? '\u2591' : '-'
  return full.repeat(filled) + empty.repeat(width - filled)
}

/** @description 进度条宽度：有列宽信息时按剩余空间收缩，避免一行折行把界面打乱 */
function barWidth(): number {
  if (!progressInPlace) return BAR_WIDTH_PLAIN
  const columns = process.stdout.columns ?? 0
  if (columns <= 0) return BAR_WIDTH_TTY
  return Math.max(10, Math.min(BAR_WIDTH_TTY, columns - 70))
}

/**
 * @description 记一次速率采样，只保留最近 RATE_WINDOW_MS 内的样本
 * @param fileBytes 已收文件字节数
 */
function recordRateSample(fileBytes: number): void {
  const now = Date.now()
  rateSamples.push({ at: now, bytes: fileBytes })
  while (rateSamples.length > 2) {
    const oldest = rateSamples[0]
    if (!oldest || now - oldest.at <= RATE_WINDOW_MS) break
    rateSamples.shift()
  }
}

/**
 * @description 最近一段时间的收片速率（字节/秒）
 * @returns 字节/秒；样本不足时返回 0（此时不显示“剩余”）
 */
function currentRate(): number {
  if (rateSamples.length < 2) return 0
  const first = rateSamples[0]
  const last = rateSamples[rateSamples.length - 1]
  if (!first || !last) return 0
  const span = last.at - first.at
  if (span < 500) return 0
  return Math.max(0, ((last.bytes - first.bytes) / span) * 1000)
}

/**
 * @description 当前正在收的那一帧收到哪了。
 *
 * 依据是切分器里的半行缓冲：帧要“整行到齐”才算收到，但字节是连续到的，
 * 所以大文件里这一句能让人看出“正在收第 42 片、已经 63%”，而不是盯着一个不动的百分比。
 * @returns 形如 `第 42 片 63%`；没有半帧或无法判断时返回空串
 */
function frameInFlightText(): string {
  const task = meta
  if (!task || mergeDone >= 0) return ''
  // `--in` 是把整份文件一次读完的，半行缓冲里可能已经排了好几帧，显示“当前这一片”只会误导
  if (options.input !== null) return ''
  const partial = pendingFrameText
  if (partial.length === 0 || !partial.startsWith('@T2')) return ''

  if (partial.startsWith(MARKERS.begin)) {
    return `正在收开始帧（${partial.length} 字符）`
  }

  const match = /^@T2D (\S+) (\d+) (\S+) ([0-9a-f]{8})/.exec(partial)
  if (!match) return '正在收数据帧…'
  const job = match[1] as string
  const seq = match[2] as string
  const bytesText = match[3] as string
  const crc = match[4] as string
  const bytes = Number(bytesText)
  // 片号在协议里从 0 开始，给人看的“第几片”从 1 开始
  const order = Number(seq)
  const label = Number.isInteger(order) ? String(order + 1) : seq
  if (!Number.isInteger(bytes) || bytes < 0) return `正在收第 ${label} 片…`

  // 帧长 = 帧头（@T2D job seq bytes crc32）+ 空格 + 头 CRC（8）+ 空格 + 载荷字符数
  const head = `${MARKERS.data} ${job} ${seq} ${bytesText} ${crc}`
  const total = head.length + 1 + 8 + 1 + symbolCount(bytes, task.alphabet)
  const ratio = total === 0 ? 0 : Math.min(1, partial.length / total)
  const elapsed = lastShardAt > 0 ? Date.now() - lastShardAt : 0
  const slow = elapsed >= FRAME_SLOW_HINT_MS ? `（已收 ${formatSpan(elapsed)}）` : ''
  return `第 ${label} 片 ${(ratio * 100).toFixed(0)}%${slow}`
}

/**
 * @description 把字节数格式化成人读的大小
 * @param bytes 字节数
 * @returns 形如 `12.3 MB`
 */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * @description 把毫秒格式化成人读的时长
 * @param ms 时长（毫秒）
 * @returns 形如 `3 分 20 秒`
 */
function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}

/**
 * @description 生成一行进度文本：等待 / 收片 / 合并三个阶段各显示各自有用的字段
 * @returns 一行进度文本（终端下带颜色与进度条）
 */
function progressText(): string {
  const task = meta
  if (!task) {
    return paint(
      `等待开始帧 · 已 ${formatSpan(Date.now() - startedAt)}（在目标机按「开始发送」）`,
      ANSI.yellow
    )
  }

  if (mergeDone >= 0) {
    const ratio = mergeTotal === 0 ? 1 : mergeDone / mergeTotal
    const elapsed = Math.max(1, Date.now() - mergeStartedAt)
    const perSecond = (task.size * ratio * 1000) / elapsed
    const tail =
      ratio >= 1
        ? '校验通过后写出文件'
        : perSecond > 0
          ? `${formatSize(perSecond)}/s · 剩余 ${formatSpan(
              ((task.size * (1 - ratio)) / perSecond) * 1000
            )}`
          : '解压 / 校验中…'
    return [
      paint('合并', ANSI.magenta),
      renderBar(ratio, barWidth()),
      paint(`${(ratio * 100).toFixed(1)}%`, ANSI.bold),
      `${mergeDone}/${mergeTotal} 片`,
      tail
    ].join('  ')
  }

  const count = done.size
  const ratio = task.total === 0 ? 1 : count / task.total
  const fileBytes = Math.round(task.size * ratio)
  const rate = currentRate()
  const parts = [
    paint('接收', ANSI.cyan),
    renderBar(ratio, barWidth()),
    paint(`${(ratio * 100).toFixed(1)}%`, ANSI.bold),
    `${count}/${task.total} 片`
  ]

  // 正在收的那一片：字节连续到，帧要整行才算收到，这里把“半帧”的进展也报出来
  const inFlight = ratio < 1 ? frameInFlightText() : ''
  if (inFlight.length > 0) parts.push(paint(inFlight, ANSI.dim))

  parts.push(`${formatSize(fileBytes)}/${formatSize(task.size)}`)

  if (ratio >= 1) parts.push('已收齐，等待合并')
  else if (rate > 0) {
    parts.push(
      `${formatSize(rate)}/s · 剩余 ${formatSpan(((task.size - fileBytes) / rate) * 1000)}`
    )
  } else if (inFlight.length === 0) {
    // 已经有半片在收了就别再喊“等待首片”，否则自相矛盾
    parts.push(fileBytes > 0 ? '测速中…' : '等待首片…')
  }

  if (failures.size > 0) parts.push(paint(`失败 ${failures.size} 片`, ANSI.red))
  return parts.join('  ')
}

/**
 * @description 画一行进度：终端里原地重绘，管道/日志里按间隔逐行打
 * @param text 进度文本
 * @param force 是否忽略节流立即重画
 */
function drawProgress(text: string, force = false): void {
  if (!progressEnabled()) return
  const now = Date.now()
  const interval = progressInPlace ? PROGRESS_TTY_INTERVAL_MS : PROGRESS_LINE_INTERVAL_MS
  if (!force && now - lastProgressAt < interval) return
  lastProgressAt = now

  if (!progressInPlace) {
    process.stdout.write(`${text}\n`)
    return
  }
  // 原地重绘：按**可见宽度**补空格（颜色序列不占宽度）
  const width = visibleWidth(text)
  const pad = width >= progressLastWidth ? '' : ' '.repeat(progressLastWidth - width)
  process.stdout.write(`\r${text}${pad}`)
  progressLastWidth = width
  progressDrawn = true
}

/** @description 结束进度行（后面要打别的输出时先调用，否则会接在进度行尾巴上） */
function clearProgressLine(): void {
  if (!progressDrawn) return
  process.stdout.write('\n')
  progressDrawn = false
  progressLastWidth = 0
}

/** @description 收到任何输入（哪怕只是半帧）：记下“上游还活着”，用于区分卡住与正在收 */
function noteInput(): void {
  lastInputAt = Date.now()
}

/**
 * @description 收下一整片：更新速率采样并重画进度
 * @param force 是否忽略节流（开始帧 / 收齐时用）
 */
function noteProgress(force = false): void {
  const now = Date.now()
  lastInputAt = now
  lastShardAt = now
  const task = meta
  if (task) {
    const ratio = task.total === 0 ? 1 : done.size / task.total
    recordRateSample(Math.round(task.size * ratio))
  }
  drawProgress(progressText(), force)
}

/**
 * @description 启动进度刷新与“没有任何输入”提醒。
 *
 * 判据是**最后一次收到字节**的时刻：一个 16 KB 的片要打几十秒，用“最后一次收下整片”当判据
 * 会在每片期间反复误报“没收到新片”。现在只要上游还在打字就一直不报，只有真的断了输入才提醒，
 * 且两次提醒之间留 20 秒间隔。
 */
function startProgressLoop(): void {
  if (!progressEnabled()) return

  const timer = setInterval(() => {
    const now = Date.now()
    const merging = mergeDone >= 0
    const finished = merging || (meta !== null && done.size >= meta.total)
    const idleMs = now - Math.max(lastInputAt, startedAt)

    if (!finished && idleMs >= IDLE_WARN_MS) {
      if (now - lastIdleWarnAt < IDLE_WARN_REPEAT_MS) return
      lastIdleWarnAt = now
      const where = meta ? `（${done.size}/${meta.total} 片已完成）` : '（还没收到开始帧）'
      const hint = paint(
        `! 已 ${formatSpan(idleMs)}没有任何输入${where}：` +
          '上游可能停了、链路卡住，或目标窗口里弹出的模态框挡住了输入',
        ANSI.yellow
      )
      if (progressInPlace) drawProgress(`${progressText()}  ${hint}`, true)
      else process.stdout.write(`${hint}\n`)
      return
    }
    drawProgress(progressText())
  }, 1000)
  // 显示用途的定时器不能拖住进程退出
  timer.unref?.()
}

/**
 * @description 合并阶段进度：读盘 + 解压 + 哈希是一趟流水线，按片数报最直观
 * @param count 已合并片数
 * @param total 总片数
 */
function reportMergeProgress(count: number, total: number): void {
  if (mergeStartedAt === 0) mergeStartedAt = Date.now()
  mergeTotal = total
  mergeDone = count
  // 最后一片必须画出来（否则节流会让界面停在 99%）
  drawProgress(progressText(), count >= total)
}

/** @description 一段片号文本太长时截断显示（完整列表仍然打在 #MISS 行里） */
function compactIndexList(text: string, limit = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 打印普通信息（quiet 时静默）。 */
function info(line: string): void {
  if (quiet) return
  clearProgressLine()
  process.stdout.write(`${line}\n`)
}

/** 打印回执行（`#` 前缀，Typer 与操作者约定的输出格式）。 */
function ack(line: string): void {
  clearProgressLine()
  process.stdout.write(`${line}\n`)
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * @description 自检：编解码往返、CRC、帧解析、片号区间
 * @returns 退出码
 */
function runSelfTest(): number {
  const failures: string[] = []
  const check = (name: string, condition: boolean): void => {
    if (!condition) failures.push(name)
  }

  try {
    for (const alphabet of ['ascii32', 'ascii64', 'hex'] as const) {
      for (const size of [0, 1, 2, 3, 7, 8, 16, 255, 1024, 4096]) {
        const bytes = Buffer.allocUnsafe(size)
        for (let index = 0; index < size; index++) bytes[index] = (index * 37 + 11) & 0xff
        const text = encodeSymbols(bytes, alphabet)
        const back = decodeSymbols(text, alphabet, size)
        check(`${alphabet} 往返 ${size}B`, Buffer.compare(Buffer.from(back), bytes) === 0)
      }
    }

    const beginFrame = buildBeginFrame({
      job: 'a1b2c3d4',
      total: 10,
      size: 1000,
      wire: 400,
      chunk: 128,
      name: 'x.bin',
      alphabet: 'ascii32',
      compression: 'br',
      mode: 'term',
      sha256: 'a'.repeat(64)
    })
    const begin = parseFrame(beginFrame)
    check('开始帧解析', begin.kind === 'begin' && begin.total === 10)

    const bytes = Buffer.from('hi')
    const payload = encodeSymbols(bytes, 'hex')
    const data = parseFrame(
      buildDataFrame({
        job: 'a1b2c3d4',
        seq: 3,
        bytes: bytes.length,
        crc32: crc32Hex(bytes),
        payload
      })
    )
    check('数据帧解析', data.kind === 'data' && data.seq === 3)
    if (data.kind === 'data') {
      verifyDataFrame(data, decodeSymbols(data.payload, 'hex', data.bytes))
      check('片校验', true)

      // 帧头被改写（模拟链路丢了一个字符）必须当场拒绝，而不是按错误规模接收
      const tampered = beginFrame.replace(' 1000 ', ' 100 ')
      let rejected = false
      try {
        parseFrame(tampered)
      } catch (error) {
        rejected = error instanceof FrameError && error.code === 'crc'
      }
      check('帧头 CRC 能抓到丢字符', rejected)
    }

    const resume = parseFrame('@T2R a1b2c3d4 10 3-5')
    check('续传帧解析', resume.kind === 'resume' && resume.missing.join(',') === '3,4,5')
    check('区间格式化', formatIndexList([0, 1, 2, 5, 7, 8], 10) === '0-2,5,7-8')
    check('缺失片计算', missingIndexes(5, [0, 2, 4]).join(',') === '1,3')

    const sanitized = sanitizeLine('\u001b[200~@T2H x\u001b[201~')
    check('bracketed paste 清理', sanitized === '@T2H x')
  } catch (error) {
    failures.push(`异常：${error instanceof Error ? error.message : String(error)}`)
  }

  if (failures.length > 0) {
    process.stderr.write(`自检失败：\n${failures.map((item) => `  - ${item}`).join('\n')}\n`)
    return EXIT.BAD
  }
  process.stdout.write('自检通过：编解码往返、CRC、帧解析、片号区间均正常\n')
  return EXIT.OK
}

// ---------------------------------------------------------------------------
// 任务状态
// ---------------------------------------------------------------------------

interface TaskMeta {
  job: string
  total: number
  size: number
  wire: number
  chunk: number
  alphabet: ParsedBeginFrame['alphabet']
  compression: ParsedBeginFrame['compression']
  mode: ParsedBeginFrame['mode']
  sha256: string
  name: string | null
}

let meta: TaskMeta | null = null
let dir = ''
let reportPath: string | null =
  options.report && options.report !== '-' ? resolve(options.report) : null
const done = new Set<number>()
const missing = new Set<number>()
const failures = new Map<number, string>()
let pendingEnd: ParsedEndFrame | null = null
let noiseLines = 0
let receivedChunks = 0
let receivedWire = 0

/**
 * @description 某片的分片文件路径（文件名带 CRC，续传时可确认是不是同一份数据）
 * @param seq 片号
 * @param crc 该片线上字节的 CRC32
 * @returns 路径
 */
function partPath(seq: number, crc: string): string {
  return join(dir, `p${seq}-${crc}.bin`)
}

/**
 * @description 该片期望的线上字节数（末片可能更小）
 * @param seq 片号
 * @returns 字节数
 */
function expectedBytes(seq: number): number {
  const task = meta as TaskMeta
  const head = task.total - 1
  if (seq < head) return task.chunk
  return task.wire - head * task.chunk
}

/**
 * @description 删除文件或整个目录，永不抛错。
 *
 * `fs.rmSync` 是 Node 14.14 才加的，更老的 14.x 退回 unlink/rmdir（否则清理会静默失败）。
 * @param target 目标路径
 * @param recursive 目录需要递归删除时为 true
 */
function removePath(target: string, recursive = false): void {
  const rm: typeof rmSync | undefined = rmSync
  if (rm) {
    try {
      rm(target, { recursive, force: true })
    } catch {
      // 删不掉不影响结果
    }
    return
  }
  try {
    unlinkSync(target)
  } catch {
    if (recursive) {
      try {
        for (const entry of readdirSync(target)) removePath(join(target, entry), true)
      } catch {
        // 不是目录（或已经不存在）
      }
    }
    try {
      rmdirSync(target)
    } catch {
      // 删不掉不影响结果
    }
  }
}

/** 保存任务元信息（重启后没有开始帧也能续传）。 */
function saveMeta(): void {
  if (!meta || options.probe) return
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
}

/**
 * @description 读取磁盘上的任务元信息
 * @param path 分片目录
 * @returns 元信息或 null
 */
function loadMeta(path: string): TaskMeta | null {
  const file = join(path, 'meta.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as TaskMeta
    if (
      typeof parsed.job === 'string' &&
      Number.isInteger(parsed.total) &&
      Number.isInteger(parsed.size) &&
      Number.isInteger(parsed.wire)
    ) {
      return parsed
    }
  } catch {
    // 坏掉的 meta.json 当作不存在：宁可重收也不要按错误的规模合并
  }
  return null
}

/**
 * @description 写续传报告（`resume.json`），操作者可以整份粘回 Typer
 * @param force 即使 quiet 也尝试写
 */
function writeReport(force = false): void {
  if (!meta || options.probe || !reportPath) return
  const missingList = missingIndexes(meta.total, [...done])
  const report = {
    version: REPORT_VERSION,
    job: meta.job,
    total: meta.total,
    size: meta.size,
    wire: meta.wire,
    sha256: meta.sha256,
    done: done.size,
    doneRanges: formatIndexList([...done], meta.total),
    missing: formatIndexList(missingList, meta.total),
    failures: [...failures.entries()].map(([seq, code]) => ({ seq, code })),
    updatedAt: new Date().toISOString()
  }
  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2))
  } catch (error) {
    if (force && verbose) {
      info(`写续传报告失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * @description 应用任务元信息：建目录、初始化缺失片集合
 * @param next 任务元信息
 */
function applyMeta(next: TaskMeta): void {
  if (meta && meta.job !== next.job) {
    throw new FrameError('job', `输入流里混入了另一次任务（${next.job}），当前任务是 ${meta.job}`)
  }
  meta = next
  dir = options.dir ? resolve(options.dir) : resolve(`.typer-${next.job}`)
  if (!options.probe) mkdirSync(dir, { recursive: true })
  if (!options.probe && !reportPath) reportPath = join(dir, 'resume.json')
  saveMeta()
  for (let index = 0; index < next.total; index++) if (!done.has(index)) missing.add(index)
}

/**
 * @description 扫描已有分片，按文件名里的 CRC 与大小确认它们属于当前任务
 * @returns 命中的片数
 */
function scanExistingParts(): number {
  if (options.probe || !meta || !existsSync(dir)) return 0
  if (!options.resume) {
    for (const entry of readdirSync(dir)) {
      if (/^p\d+-[0-9a-f]{8}\.bin$/.test(entry)) {
        try {
          unlinkSync(join(dir, entry))
        } catch {
          // 忽略
        }
      }
    }
    return 0
  }
  let found = 0
  for (const entry of readdirSync(dir)) {
    const match = /^p(\d+)-([0-9a-f]{8})\.bin$/.exec(entry)
    if (!match) continue
    const seq = Number(match[1])
    if (seq >= meta.total) continue
    if (statSync(join(dir, entry)).size !== expectedBytes(seq)) continue
    done.add(seq)
    missing.delete(seq)
    found += 1
  }
  return found
}

/**
 * @description 处理开始帧
 * @param frame 开始帧
 */
function handleBegin(frame: ParsedBeginFrame): void {
  if (frame.wire > 0 && frame.total !== Math.ceil(frame.wire / frame.chunk)) {
    throw new FrameError(
      'field',
      `开始帧规模自相矛盾：wire=${frame.wire} chunk=${frame.chunk} total=${frame.total}`
    )
  }
  applyMeta({
    job: frame.job,
    total: frame.total,
    size: frame.size,
    wire: frame.wire,
    chunk: frame.chunk,
    alphabet: frame.alphabet,
    compression: frame.compression,
    mode: frame.mode,
    sha256: frame.sha256,
    name: frame.name
  })
  const found = scanExistingParts()
  info(
    `${paint('接收开始', ANSI.cyan)}  ${frame.total} 片 · 文件 ${formatSize(frame.size)}` +
      `（线上 ${formatSize(frame.wire)}，每片 ${formatSize(frame.chunk)}）· ` +
      `${frame.alphabet} / ${frame.compression} / ${frame.mode}` +
      (found > 0 ? ` · ${paint(`续传已有 ${found} 片`, ANSI.yellow)}` : '')
  )
  info(
    `${paint('  输出', ANSI.dim)} ${options.out ?? frame.name ?? `job-${frame.job}.bin`}` +
      `   ${paint('分片', ANSI.dim)} ${dir}`
  )
  noteProgress(true)
}

/**
 * @description 处理数据帧：解码 → 校验 → 落盘
 * @param frame 数据帧
 */
function handleData(frame: ParsedDataFrame): void {
  const task = meta
  if (!task) {
    throw new FrameError('job', '还没收到开始帧，无法确定任务规模（先发开始帧或指定 --dir 续传）')
  }
  if (frame.job !== task.job) {
    throw new FrameError('job', `该片属于任务 ${frame.job}，当前任务是 ${task.job}`)
  }
  if (frame.seq >= task.total) {
    throw new FrameError('range', `片号 ${frame.seq} 超出总数 ${task.total}`)
  }
  const expected = expectedBytes(frame.seq)
  if (frame.bytes !== expected) {
    throw new FrameError(
      'len',
      `片 ${frame.seq} 长度不符：期望 ${expected}，帧里声明 ${frame.bytes}`
    )
  }

  const wire = decodeSymbols(frame.payload, task.alphabet, frame.bytes)
  verifyDataFrame(frame, wire)
  receivedChunks += 1
  receivedWire += wire.length
  done.add(frame.seq)
  missing.delete(frame.seq)

  if (options.probe) {
    noteProgress()
    return
  }

  const target = partPath(frame.seq, frame.crc32)
  // 同名分片已存在（同片同 CRC）→ 跳过，整批重放也不会重复写盘
  if (existsSync(target)) {
    noteProgress()
    return
  }

  // 同片不同 CRC（上次那版是坏的）：先删掉旧文件，避免续传时被误认为已完成
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`p${frame.seq}-`) && entry.endsWith('.bin')) {
      try {
        unlinkSync(join(dir, entry))
      } catch {
        // 删不掉也不影响：新文件用新 CRC 命名
      }
    }
  }
  writeFileSync(target, wire)
  if (verbose && receivedChunks % 32 === 0) info(`已收 ${receivedChunks}/${task.total} 片`)
  noteProgress()
}

/**
 * @description 按序读分片的流
 * @param total 总片数
 * @param crcs 片号 → CRC
 * @returns 可读流
 */
function partStream(total: number, crcs: Map<number, string>): Readable {
  function* generate(): Generator<Buffer> {
    for (let seq = 0; seq < total; seq++) {
      yield readFileSync(partPath(seq, crcs.get(seq) as string))
      reportMergeProgress(seq + 1, total)
    }
  }
  return Readable.from(generate())
}

/**
 * @description 找出磁盘上每片的 CRC
 * @returns 片号 → CRC
 */
function collectPartCrcs(): Map<number, string> {
  const map = new Map<number, string>()
  for (const entry of readdirSync(dir)) {
    const match = /^p(\d+)-([0-9a-f]{8})\.bin$/.exec(entry)
    if (match) map.set(Number(match[1]), match[2])
  }
  return map
}

/**
 * @description 算出输出路径（防目录穿越、处理覆盖策略）
 * @returns 输出路径；不允许写出时返回 null
 */
function resolveOutputPath(): string | null {
  const task = meta as TaskMeta
  if (options.out) return resolve(options.out)
  const raw = task.name && task.name.length > 0 ? basename(task.name) : `job-${task.job}.bin`
  // eslint-disable-next-line no-control-regex -- 这里要挡掉的是文件名里不可能出现的控制字符
  const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || `job-${task.job}.bin`
  const path = join(dir, name)
  if (!path.startsWith(dir + sep)) {
    info(`拒绝写出到分片目录之外：${path}`)
    return null
  }
  if (existsSync(path) && !options.overwrite) {
    info(`输出文件已存在且指定了 --no-overwrite：${path}`)
    return null
  }
  return path
}

/**
 * @description 合并分片、解压（必要时）、校验整文件并写出
 * @returns 退出码
 */
async function mergeAndVerify(): Promise<number> {
  const task = meta as TaskMeta
  const missingList = missingIndexes(task.total, [...done])
  if (missingList.length > 0) {
    ack(`#MISS ${formatIndexList(missingList, task.total)}`)
    ack(buildResumeToken({ job: task.job, total: task.total, missing: missingList }))
    writeReport(true)
    info(
      `数据不全：还缺 ${missingList.length}/${task.total} 片（${compactIndexList(
        formatIndexList(missingList, task.total)
      )}）。\n  → 在 Typer 里粘贴上面的 @T2R 令牌，只补这些片即可；已收到的分片全部保留。`
    )
    return EXIT.INCOMPLETE
  }

  const crcs = collectPartCrcs()
  mergeTotal = task.total
  mergeDone = 0
  mergeStartedAt = Date.now()
  drawProgress(progressText(), true)
  const source = task.total === 0 ? Readable.from([]) : partStream(task.total, crcs)
  const outputPath = resolveOutputPath()
  if (outputPath === null) return EXIT.USAGE

  const hash = createHash('sha256')
  let produced = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      produced += chunk.length
      callback(null, chunk)
    }
  })

  try {
    const sink = createWriteStream(outputPath)
    if (task.compression === 'br') {
      await pipeline(source, createBrotliDecompress(), meter, sink)
    } else {
      await pipeline(source, meter, sink)
    }
  } catch (error) {
    // 半成品必须删掉：留着会让人误以为"已经有结果了"
    removePath(outputPath)
    ack(`#BAD decode`)
    info(
      `合并/解压失败：${error instanceof Error ? error.message : String(error)}\n` +
        '  → 压缩档依赖"全部片都正确"。分片已保留，可继续续传；仍失败就改用不压缩重传。'
    )
    return EXIT.BAD
  }

  const actual = hash.digest('hex')
  if (produced !== task.size) {
    ack('#BAD len')
    info(`整文件大小不符：期望 ${task.size}，实际 ${produced}。分片保留，可继续续传。`)
    return EXIT.BAD
  }
  if (actual !== task.sha256) {
    ack('#BAD sha256')
    info(
      `整文件 SHA-256 不符：期望 ${task.sha256}，实际 ${actual}。\n` +
        '  → 数据在链路上被改写（常见原因：输入法、编辑器自动缩进/自动闭合）。分片保留，请改用 ASCII 档重传。'
    )
    return EXIT.BAD
  }

  if (options.keepParts) {
    writeReport(true)
  } else if (outputPath.startsWith(dir + sep)) {
    // 输出文件就在分片目录里：只清分片与报告，别把结果一起删了
    const keep = basename(outputPath)
    for (const entry of readdirSync(dir)) {
      if (entry === keep) continue
      removePath(join(dir, entry), true)
    }
  } else {
    removePath(dir, true)
  }

  ack(`#DONE ${task.size} ${actual} ${outputPath}`)
  if (options.stats) {
    const ms = Math.max(1, Date.now() - startedAt)
    const bits = task.alphabet === 'ascii32' ? 5 : task.alphabet === 'ascii64' ? 6 : 4
    const chars = task.wire === 0 ? 0 : Math.ceil((task.wire * 8) / bits)
    ack(
      `#STATS chunks=${task.total} bytes=${task.size} wire=${task.wire} chars=${chars} ` +
        `ms=${ms} cps=${Math.round(chars / (ms / 1000))}`
    )
  }
  if (!quiet) {
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    const average = (task.size / elapsedMs) * 1000
    info(
      `${paint('✔ 完成', ANSI.green)}  ${formatSize(task.size)} · ${task.total} 片 · ` +
        `用时 ${formatSpan(elapsedMs)} · 平均 ${formatSize(average)}/s · SHA-256 已校验`
    )
    info(`  ${paint('输出', ANSI.dim)} ${outputPath}`)
  }
  return EXIT.OK
}

// ---------------------------------------------------------------------------
// 输入流
// ---------------------------------------------------------------------------

/**
 * @description 帧切分器：行尾与下一个 `@T2` 标记都算边界。
 *
 * 这样同一份实现同时覆盖三种目标端：
 *   · 终端：每帧后面有 CR；
 *   · 单行输入框：完全没有换行，只靠 `@T2` 标记分隔；
 *   · 编辑器：CRLF。
 * 载荷符号表里没有 `@`，所以 `@T2` 一定不是数据的一部分。
 * @returns 可增量喂入的切分器
 */
function createStreamSplitter(): { push(text: string): string[]; flush(): string[] } {
  let buffer = ''
  const markers = Object.values(MARKERS)

  /**
   * @description 判断位置 pos 处是否是一个帧标记
   * @param pos 位置
   * @returns 是否命中
   */
  function markerAt(pos: number): boolean {
    for (const marker of markers) {
      if (buffer.startsWith(`${marker} `, pos)) return true
    }
    return false
  }

  /**
   * @description 切出所有完整帧
   * @param text 新到文本
   * @returns 完整帧文本
   */
  function push(text: string): string[] {
    buffer += text
    const lines: string[] = []
    let start = 0
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index]
      if (char === '\n' || char === '\r') {
        lines.push(buffer.slice(start, index))
        if (char === '\r' && buffer[index + 1] === '\n') index += 1
        start = index + 1
        continue
      }
      if (char === '@' && index > start && markerAt(index)) {
        lines.push(buffer.slice(start, index))
        start = index
      }
    }
    buffer = buffer.slice(start)
    pendingFrameText = buffer
    if (buffer.length > MAX_LINE_CHARS) {
      throw new FrameError('overlong', `单帧超过 ${MAX_LINE_CHARS} 字符上限`)
    }
    return lines.filter((line) => line.length > 0)
  }

  /**
   * @description 收尾：吐出残留
   * @returns 最后一段
   */
  function flush(): string[] {
    const rest = buffer
    buffer = ''
    pendingFrameText = ''
    return rest.length > 0 ? [rest] : []
  }

  return { push, flush }
}

/** 把控制台切到 UTF-8 代码页（15 位档的 CJK 字符要靠它原样进 stdin）。 */
function ensureUtf8Console(): void {
  if (process.platform !== 'win32') return
  try {
    spawnSync('cmd.exe', ['/c', 'chcp 65001 >nul'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // 切不了就按当前代码页读：非 ASCII 档会报符号表之外的字符，用户可改用 ASCII 档
  }
}

/**
 * @description 主循环：先挂监听再读输入、分发帧，最后合并校验
 * @returns 退出码
 */
async function run(): Promise<number> {
  const splitter = createStreamSplitter()

  // 指定了 --dir 且目录里有 meta.json：即使这次没有开始帧也能续传
  if (options.dir) {
    dir = resolve(options.dir)
    const loaded = loadMeta(dir)
    if (loaded) {
      applyMeta(loaded)
      const found = scanExistingParts()
      if (found > 0 && !quiet) info(`续传：目录里已有 ${found}/${loaded.total} 片`)
    }
  }

  /**
   * @description 逐条处理，并判断是否已收到结束帧
   * @param lines 待处理的行
   * @returns 是否应停止读取
   */
  const consume = (lines: string[]): boolean => {
    for (const line of lines) {
      handleLine(line)
      if (pendingEnd) return true
    }
    return false
  }

  let ended = false
  const source = options.input ? createReadStream(resolve(options.input), 'utf8') : process.stdin

  if (!options.input) {
    if (process.stdin.isTTY && !options.cooked) {
      ensureUtf8Console()
      process.stdin.setRawMode(true)
      if (!quiet) info('（raw 模式：不回显、无行宽限制；Ctrl+C 中止）')
    }
    process.stdin.setEncoding('utf8')
  }

  /**
   * @description 输入流回调：处理 Ctrl+C / Ctrl+D 与普通数据
   * @param chunk 输入数据块
   */
  const onData = (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // 任何字节都算“上游还活着”：帧要整行才算收到，但靠这个才不会把“正在收长片”误报成断流
    noteInput()
    if (text.includes('\u0003')) {
      ended = true
      source.destroy()
      return
    }
    if (text.includes('\u0004')) {
      if (consume(splitter.push(text.slice(0, text.indexOf('\u0004'))))) ended = true
      source.destroy()
      return
    }
    if (consume(splitter.push(text))) {
      ended = true
      // 交互式输入流（TTY）不会自己 EOF：结束帧就是"传输完成"的信号，收到就收工
      if (process.stdin.isTTY && !options.input) source.destroy()
    }
  }

  source.on('data', onData)
  source.resume()
  startProgressLoop()

  await new Promise<void>((resolvePromise) => {
    const finish = (): void => resolvePromise()
    source.on('end', finish)
    source.on('close', finish)
    source.on('error', (error) => {
      info(`读取输入失败：${error.message}`)
      finish()
    })
  })

  if (!ended) consume(splitter.flush())

  if (options.probe) {
    ack(
      `#PROBE chunks=${receivedChunks} wire=${receivedWire} noise=${noiseLines} alpha=${
        meta ? meta.alphabet : '-'
      }`
    )
    return receivedChunks > 0 ? EXIT.OK : EXIT.INCOMPLETE
  }

  if (!meta) {
    info('没有收到任何有效帧。请确认输入流里是 Typer 生成的 v2 帧（帧头以 @T2 开头）。')
    return noiseLines > 0 ? EXIT.INCOMPLETE : EXIT.USAGE
  }

  if (pendingEnd) {
    if (pendingEnd.job !== meta.job) {
      ack('#FAIL - job')
      info(`结束帧属于任务 ${pendingEnd.job}，当前任务是 ${meta.job}。`)
    } else if (pendingEnd.sha256 !== meta.sha256 || pendingEnd.size !== meta.size) {
      ack('#FAIL - field')
      info('结束帧的整文件哈希/大小与开始帧不一致：可能混入了另一次任务的数据。')
    }
  }

  if (missingIndexes(meta.total, [...done]).length > 0) return mergeAndVerify()
  if (!pendingEnd) {
    info('未收到结束帧，但所有分片都已通过逐片校验，继续按开始帧的哈希合并校验。')
  }
  return mergeAndVerify()
}

/**
 * @description 处理一行输入：解析 → 分发；解析/校验失败只影响该片
 * @param rawLine 原始行
 */
function handleLine(rawLine: string): void {
  const line = sanitizeLine(rawLine)
  if (line.length === 0) return

  let frame
  try {
    frame = parseFrame(line)
  } catch (error) {
    const code = error instanceof FrameError ? error.code : 'field'
    if (code === 'empty') return
    noiseLines += 1
    if (verbose) {
      info(`忽略无法解析的行（${code}）：${(error instanceof Error && error.message) || ''}`)
    } else if (noiseLines <= 3) {
      // 带上具体原因：像"片号分隔符只接受英文字符"这种提示，比"混入了回显"有用得多
      const detail = error instanceof Error && error.message ? `：${error.message}` : ''
      info(`忽略无法解析的行（${code}）${detail}。若持续出现，请检查是否混入了终端回显或提示符。`)
    }
    return
  }

  try {
    if (frame.kind === 'begin') handleBegin(frame)
    else if (frame.kind === 'data') handleData(frame)
    else if (frame.kind === 'end') pendingEnd = frame
    else info(`提示：这是一条续传令（缺 ${formatIndexList(frame.missing, frame.total)}）。`)
  } catch (error) {
    const code = error instanceof FrameError ? error.code : 'field'
    const seq = frame.kind === 'data' ? frame.seq : '-'
    ack(`#FAIL ${seq} ${code}`)
    if (seq !== '-') {
      failures.set(Number(seq), code)
      missing.add(Number(seq))
      done.delete(Number(seq))
    }
    info(
      `片 ${seq} 失败（${code}）：${error instanceof Error ? error.message : String(error)}\n` +
        `  → ${ERROR_HINTS[code] ?? '请重传该片'}`
    )
  }
}

run()
  .then((code) => {
    process.exit(typeof code === 'number' ? code : EXIT.OK)
  })
  .catch((error) => {
    info(`未预期的错误：${error instanceof Error ? error.stack : String(error)}`)
    process.exit(EXIT.USAGE)
  })
