/**
 * Typer 文件接收端（线格式 v2）。
 *
 * 设计目标只有一个：在"只能逐字符输入"的链路上尽量少打字符、尽量快，并且**一定不能写坏数据**。
 *
 *   · 载荷是 15 / 6 / 4 比特一个字符的符号流（见 src/main/util/codec.ts），15 位档把字符数压到十六进制的 1/3.75；
 *   · 整文件先压缩再切片（`br`）或直接切片（`none`），每片自带 CRC32，整文件带 SHA-256；
 *   · 传输期间只刷“进度”本身：终端里原地重绘（两行 → 单行 → 逐行日志按能力降级），
 *     输出**永远不会超出终端宽度**——超宽会被终端折行，原地重绘就会错乱成“一行行往上滞”；
 *   · 走 raw 模式并关回显；启动时用一次 **隐藏的** PowerShell 把控制台切到 UTF-8 + 开 ANSI，
 *     并把目标窗口切到英文直输（与主程序 `typing-host.ps1` 同一套逻辑），**退出时还原**；
 *   · 默认边收边落盘，中断后重跑即可续传；失败只补缺失片。
 *
 * 分层：帧解析与落盘在本文件；排版 / 着色 / 输出 / 控制台能力分别在 `recv/` 下的
 * progress.ts / text.ts / screen.ts / console.ts，均为纯函数或只碰终端的薄层，便于单独测试。
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
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
import { describeIme, prepareConsole, restoreConsoleIme, type ConsoleSetup } from './recv/console'
import { formatPercent, formatSize, formatSpan } from './recv/format'
import { buildView, layoutProgress, rowWidth, type ViewInput } from './recv/progress'
import { Screen, type ScreenMode } from './recv/screen'
import { paint, type Style } from './recv/text'

const EXIT = { OK: 0, INCOMPLETE: 2, BAD: 3, USAGE: 4 }
const REPORT_VERSION = 2

/** 分片目录里的单实例锁文件名（两个接收端同时写同一批分片会互相覆盖） */
const LOCK_FILE = '.recv-lock'

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
      --progress <mode>   进度回显：auto（终端下自动，默认）/ on / plain（逐行，写日志用）/ off
      --ime <mode>        启动时切英文直输、退出时还原：auto（默认，交互式终端才切）/ on / off
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
  /** 进度回显：auto = 只有“人坐在终端前面”时开；on / plain / off 强制 */
  progress: 'auto' | 'on' | 'plain' | 'off'
  /**
   * 输入法处理：auto = 只在“真的在用键盘输入”（交互式终端且没给 `--in`）时切英文直输
   * （中文输入法会把打进来的帧吃成候选上屏），退出时会把状态还原
   */
  ime: 'auto' | 'on' | 'off'
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
    ime: 'auto',
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
      if (value !== 'auto' && value !== 'on' && value !== 'plain' && value !== 'off') {
        throw new Error(`--progress 只接受 auto / on / plain / off（收到 ${value}）`)
      }
      options.progress = value
    } else if (arg === '--ime') {
      const value = next()
      if (value !== 'auto' && value !== 'on' && value !== 'off') {
        throw new Error(`--ime 只接受 auto / on / off（收到 ${value}）`)
      }
      options.ime = value
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
// 终端与进度回显
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
  if (options.progress === 'on' || options.progress === 'plain') return true
  return options.input === null
}

/**
 * @description 该用哪种输出方式（按需决定是否原地重绘）。
 *
 * 只有“是终端 + 支持 ANSI”才敢用两行原地重绘（要上移光标）；老式控制台退成单行原地重绘
 * （只依赖 `\r`）；重定向到日志 / 管道则一行一行打。
 *
 * 旧版把“能否原地重绘”直接绑在 `isTTY` 上、补空格又按**字符数**算，一旦忽略中文占两格，
 * 行就会超出终端宽度被**折行**——于是“有时原地刷新、有时一行行往上滚”同时出现。
 * @returns 输出模式
 */
function progressMode(): ScreenMode {
  if (!setup.caps.tty) return 'plain'
  if (options.progress === 'plain') return 'plain'
  return setup.caps.vt ? 'block' : 'row'
}

/**
 * 多久**没有任何输入**才提醒（毫秒）。
 *
 * 参照物是“最后一次收到字节”，不是“最后一次收下一整片”：一个 16 KB 的片在 400 字/秒下
 * 要打三四十秒，用“片”当参照会在这期间反复报“没收到新片”，纯属噪音。
 */
const IDLE_WARN_MS = 10_000

/** 已经提醒过之后，隔多久才允许再提一次（毫秒） */
const IDLE_WARN_REPEAT_MS = 20_000

/** 速率按最近这段时间的增量算（毫秒）：用“从开始到现在的平均值”会把卡顿与恢复都抹平 */
const RATE_WINDOW_MS = 8_000

/** 控制台能力（由 prepareConsole 在 run() 里填；未初始化时按“纯文本输出”处理） */
let setup: ConsoleSetup = {
  caps: { tty: false, vt: false, columns: 80, unicode: false, color: false },
  probed: false,
  note: null,
  ime: null
}

/** 输出层：只负责把排版好的行写到终端，不关心行里写的是什么 */
let screen = new Screen(setup.caps, 'plain', (text) => process.stdout.write(text))

/** 动画帧序号：只有原地重绘才看得到（写日志时不画转圈） */
let spinnerIndex = 0

/** 最近一次收到任何输入的时刻（毫秒）：判断“上游还在打字吗” */
let lastInputAt = 0
/** 最近一次“没有任何输入”提醒的时刻 */
let lastIdleWarnAt = 0
/** 合并阶段进度（-1 表示不在合并） */
let mergeDone = -1
let mergeTotal = 0
/** 速率采样：`{ 时刻, 已收文件字节 }`，只保留最近 RATE_WINDOW_MS */
const rateSamples: Array<{ at: number; bytes: number }> = []
/** 切分器里还没成帧的半行：用来显示“当前这一片收到哪了” */
let pendingFrameText = ''

/**
 * @description 给一段文本上色（不上色时原样返回）
 * @param text 文本
 * @param kind 样式
 * @returns 可直接写出的字符串
 */
function style(text: string, kind: Style): string {
  return paint(text, kind, setup.caps.color)
}

/**
 * @description 状态标记：终端支持 Unicode 时用符号，否则退回 ASCII（老控制台不认 `✔`）
 * @param kind 类型
 * @returns 标记文本
 */
function mark(kind: 'ok' | 'err' | 'warn'): string {
  const unicode = setup.caps.unicode
  if (kind === 'ok') return unicode ? '✔' : 'OK'
  if (kind === 'err') return unicode ? '✖' : '!!'
  return '!'
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
 * @returns 片号（0 基）与片内比例；没有半帧或无法判断时返回 null
 */
function frameInFlight(): { order: number; fraction: number } | null {
  const task = meta
  if (!task || mergeDone >= 0) return null
  // `--in` 是把整份文件一次读完的，半行缓冲里可能已经排了好几帧，显示“当前这一片”只会误导
  if (options.input !== null) return null
  const partial = pendingFrameText
  if (partial.length === 0 || !partial.startsWith('@T2')) return null
  // 开始帧没有片号，不值得为此单独报一行
  if (partial.startsWith(MARKERS.begin)) return null

  const match = /^@T2D (\S+) (\d+) (\S+) ([0-9a-f]{8})/.exec(partial)
  if (!match) return null
  const job = match[1] as string
  const seqText = match[2] as string
  const bytesText = match[3] as string
  const crc = match[4] as string
  const bytes = Number(bytesText)
  const order = Number(seqText)
  if (!Number.isInteger(order) || order < 0) return null
  if (!Number.isInteger(bytes) || bytes < 0) return { order, fraction: 0 }

  // 帧长 = 帧头（@T2D job seq bytes crc32）+ 空格 + 头 CRC（8）+ 空格 + 载荷字符数
  const head = `${MARKERS.data} ${job} ${seqText} ${bytesText} ${crc}`
  const total = head.length + 1 + 8 + 1 + symbolCount(bytes, task.alphabet)
  const fraction = total === 0 ? 0 : Math.min(1, partial.length / total)
  return { order, fraction }
}

/** @description 一段片号文本太长时截断显示（完整列表仍然打在 #MISS 行里） */
function compactIndexList(text: string, limit = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * @description 把当前状态折算成排版字段
 * @returns 排版视图输入
 */
function viewInput(): ViewInput {
  const task = meta
  return {
    now: Date.now(),
    startedAt,
    total: task ? task.total : null,
    size: task ? task.size : null,
    doneCount: done.size,
    failures: failures.size,
    inFlight: frameInFlight(),
    merge: mergeDone >= 0 ? { done: mergeDone, total: mergeTotal } : null,
    rate: currentRate(),
    lastInputAt,
    idleWarnMs: IDLE_WARN_MS,
    compressed: task ? task.compression === 'br' : false
  }
}

/**
 * @description 画进度（节流与“清掉进度块”都由输出层负责）
 * @param force 忽略节流立即重画（阶段切换 / 收齐 / 最后一片）
 */
function drawProgress(force = false): void {
  if (!progressEnabled()) return
  const mode = progressMode()
  const rows = layoutProgress(buildView(viewInput()), {
    columns: setup.caps.columns,
    unicode: setup.caps.unicode,
    maxRows: mode === 'block' ? 2 : 1,
    spinnerIndex,
    mode: mode === 'plain' ? 'plain' : 'inline'
  })
  screen.draw(rows, force)
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
  lastInputAt = Date.now()
  const task = meta
  if (task) {
    const ratio = task.total === 0 ? 1 : done.size / task.total
    recordRateSample(Math.round(task.size * ratio))
  }
  drawProgress(force)
}

/**
 * @description 启动进度刷新与“没有任何输入”提醒。
 *
 * 刷新按 300ms 走：转圈动画要够快才看得出“在动”，又不能快过终端（尤其云桌面）的回传能力。
 * 断流判据是**最后一次收到字节**的时刻，两次提醒之间留 20 秒，避免一直刷同一句话。
 */
function startProgressLoop(): void {
  if (!progressEnabled()) return

  const timer = setInterval(() => {
    spinnerIndex += 1
    const now = Date.now()
    const merging = mergeDone >= 0
    const finished = merging || (meta !== null && done.size >= meta.total)
    const idleMs = now - Math.max(lastInputAt, startedAt)

    if (!finished && idleMs >= IDLE_WARN_MS && now - lastIdleWarnAt >= IDLE_WARN_REPEAT_MS) {
      lastIdleWarnAt = now
      const where = meta ? `（已完成 ${done.size}/${meta.total} 片）` : '（还没收到开始帧）'
      info(
        style(`${mark('warn')} 已 ${formatSpan(idleMs)}没有任何输入${where}`, 'warn') +
          '：上游可能停了、链路卡住，或目标窗口里弹出的模态框挡住了输入'
      )
    }
    drawProgress()
  }, 300)
  // 显示用途的定时器不能拖住进程退出
  timer.unref?.()
}

/**
 * @description 合并阶段进度：读盘 + 解压 + 哈希是一趟流水线，按片数报最直观
 * @param count 已合并片数
 * @param total 总片数
 */
function reportMergeProgress(count: number, total: number): void {
  mergeTotal = total
  mergeDone = count
  // 最后一片必须画出来（否则节流会让界面停在 99%）
  drawProgress(count >= total)
}

/** 打印普通信息（quiet 时静默）。 */
function info(line: string): void {
  if (quiet) return
  screen.log(line)
}

/** 打印回执行（`#` 前缀，Typer 与操作者约定的输出格式）。 */
function ack(line: string): void {
  screen.log(line)
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
    for (const alphabet of ['ascii32', 'ascii64', 'b47', 'hex'] as const) {
      // 31/32/33 跨过了基数表的块边界（32 字节一块），专门用来抓“末块位数算错”
      for (const size of [0, 1, 2, 3, 7, 8, 16, 31, 32, 33, 255, 1024, 4096]) {
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

    // 排版的硬约束：任何宽度、任何阶段生成的行都不得超出终端宽度。
    // 超一格终端就会折行，而折行会让“光标上移重画”错位成一团，正是旧版看起来“乱跳”的原因。
    const view = buildView({
      now: 65_000,
      startedAt: 0,
      total: 8,
      size: 59_000,
      doneCount: 5,
      failures: 0,
      inFlight: { order: 5, fraction: 0.63 },
      merge: null,
      rate: 14_000,
      lastInputAt: 65_000,
      idleWarnMs: IDLE_WARN_MS,
      compressed: true
    })
    for (const columns of [40, 60, 72, 92, 120, 160]) {
      const rows = layoutProgress(view, {
        columns,
        unicode: true,
        maxRows: 2,
        spinnerIndex: 1,
        mode: 'inline'
      })
      check(`排版不超两行（${columns} 列）`, rows.length > 0 && rows.length <= 2)
      check(
        `排版不超宽（${columns} 列）`,
        rows.every((row) => rowWidth(row) <= columns)
      )
    }
    const asciiRows = layoutProgress(view, {
      columns: 60,
      unicode: false,
      maxRows: 1,
      spinnerIndex: 3,
      mode: 'plain'
    })
    check('纯文本排版只有一行', asciiRows.length === 1)
    check('纯文本排版不含转义序列', !asciiRows[0]?.some((item) => item.text.includes('\u001b')))
    check('百分比文案', formatPercent(0.625, 1) === '62.5%')
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

// ---------------------------------------------------------------------------
// 单实例锁
// ---------------------------------------------------------------------------

/** 锁文件路径（拿到分片目录之后才会设置） */
let lockPath: string | null = null

/**
 * @description 判断某个进程号是否还活着（Windows 上 `kill(pid, 0)` 同样可用）
 * @param pid 进程号
 * @returns 是否存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程还在，只是没权限给它发信号
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * @description 抢占“这个分片目录归我写”的锁。
 *
 * 两个接收端同时收同一批片会互相覆盖分片、各自合并一次（用户看到的“多开了一份”）；
 * 锁文件用 `wx` 原子创建，持有者进程已消失（陈旧锁）时自动接管。
 * @returns 是否拿到锁
 */
function acquireLock(): boolean {
  if (options.probe || dir.length === 0 || lockPath) return true
  const path = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      lockPath = path
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return true
    }
    let owner = 0
    try {
      owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
    } catch {
      owner = 0
    }
    if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isProcessAlive(owner)) {
      return false
    }
    // 陈旧锁：上一个实例被强杀 / 断链时留下的
    removePath(path)
  }
  return true
}

/** @description 释放锁（退出钩子也会调一次，崩溃残留由下次启动的陈旧锁检测兜住） */
function releaseLock(): void {
  const path = lockPath
  if (!path) return
  lockPath = null
  removePath(path)
}

/**
 * @description 分片目录被另一个还活着的接收端占用。
 *
 * 单独一个错误类型：它不是“某一帧坏了”，不能跟着正常的 #FAIL 流程走（那会误导成重传该片），
 * 而是直接停掉本次接收——继续写下去只会让两份进程互相覆盖分片。
 */
class LockBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockBusyError'
  }
}

/** 是否因为锁冲突已经停掉本次接收 */
let lockBlocked = false

/**
 * @description 把“另一个实例在跑”说清楚（顺便给出恢复办法）
 * @param dirPath 分片目录
 */
function reportLockBusy(dirPath: string): void {
  lockBlocked = true
  info(
    style(`${mark('err')} 另有一个接收端正在处理这个任务：${dirPath}`, 'err') +
      '\n  → 为避免两份进程互相覆盖分片，本次不再写盘。关掉多余的那个窗口后重跑；' +
      `若确认旧窗口已经结束，删掉该目录下的 ${LOCK_FILE} 再试。`
  )
}

/**
 * @description 应用任务元信息：建目录、抢锁、初始化缺失片集合
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
  if (!options.probe && !acquireLock()) throw new LockBusyError(dir)
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
    `${style(`${mark('ok')} 接收开始`, 'ok')}  ${frame.total} 片 · 文件 ${formatSize(frame.size)}` +
      `（线上 ${formatSize(frame.wire)}，每片 ${formatSize(frame.chunk)}）· ` +
      `${frame.alphabet} / ${frame.compression} / ${frame.mode}` +
      (found > 0 ? ` · ${style(`续传已有 ${found} 片`, 'warn')}` : '')
  )
  info(
    `${style('  输出', 'dim')} ${options.out ?? frame.name ?? `job-${frame.job}.bin`}` +
      `   ${style('分片', 'dim')} ${dir}`
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
      `${style(`${mark('err')} 数据不全`, 'err')}：还缺 ${missingList.length}/${task.total} 片` +
        `（${compactIndexList(formatIndexList(missingList, task.total))}）\n` +
        '  → 在 Typer 里粘贴上面的 @T2R 令牌，只补这些片即可；已收到的分片全部保留。'
    )
    return EXIT.INCOMPLETE
  }

  const crcs = collectPartCrcs()
  mergeTotal = task.total
  mergeDone = 0
  info(
    style(`${mark('ok')} 全部 ${task.total} 片已通过逐片校验`, 'ok') +
      (task.compression === 'br' ? ' · 解压并校验整文件' : ' · 校验整文件')
  )
  drawProgress(true)
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
    // 半成品必须删掉：留着会让人误以为”已经有结果了“
    removePath(outputPath)
    ack(`#BAD decode`)
    info(
      `${style(`${mark('err')} 合并/解压失败`, 'err')}：` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        '  → 压缩档依赖”全部片都正确“。分片已保留，可继续续传；仍失败就改用不压缩重传。'
    )
    return EXIT.BAD
  }

  const actual = hash.digest('hex')
  if (produced !== task.size) {
    ack('#BAD len')
    info(
      `${style(`${mark('err')} 整文件大小不符`, 'err')}：` +
        `期望 ${task.size}，实际 ${produced}。分片保留，可继续续传。`
    )
    return EXIT.BAD
  }
  if (actual !== task.sha256) {
    ack('#BAD sha256')
    info(
      `${style(`${mark('err')} 整文件 SHA-256 不符`, 'err')}：` +
        `期望 ${task.sha256}，实际 ${actual}。\n` +
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

  // 先把输入法还原：拿到结果的同时就能用自己的输入法，不必等窗口关掉
  restoreConsoleIme()
  ack(`#DONE ${task.size} ${actual} ${outputPath}`)
  if (options.stats) {
    const ms = Math.max(1, Date.now() - startedAt)
    const chars = task.wire === 0 ? 0 : symbolCount(task.wire, task.alphabet)
    ack(
      `#STATS chunks=${task.total} bytes=${task.size} wire=${task.wire} chars=${chars} ` +
        `ms=${ms} cps=${Math.round(chars / (ms / 1000))}`
    )
  }
  if (!quiet) {
    const elapsedMs = Math.max(1, Date.now() - startedAt)
    const average = (task.size / elapsedMs) * 1000
    info(
      `${style(`${mark('ok')} 传输完成`, 'ok')}  ${formatSize(task.size)} · ${task.total} 片 · ` +
        `用时 ${elapsedMs < 1000 ? '不到 1 秒' : formatSpan(elapsedMs)} · ` +
        `平均 ${formatSize(average)}/s · SHA-256 已校验`
    )
    info(`  ${style('输出', 'dim')} ${outputPath}`)
    info(`  ${style('提示', 'dim')} 关闭本窗口（或按 Ctrl+C）即可退出`)
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

/**
 * @description 把控制台 / 输入法的探测结果说清楚。
 *
 * 后续排查“中文显示成乱码”“帧被输入法吃掉”全靠这几行：正常时一行，异常时直接给怎么办。
 */
function reportConsoleSetup(): void {
  if (quiet || !setup.caps.tty) return
  if (!setup.probed) {
    if (process.platform === 'win32') {
      // 这条路径下中文很可能显示成乱码，所以这句刻意用 ASCII：至少能看懂发生了什么
      info(
        `[!] console init unavailable${setup.note ? ` (${setup.note})` : ''}: ` +
          'UTF-8 codepage / ANSI / IME switch skipped. ' +
          'Run with --progress plain if the output looks broken.'
      )
    }
    return
  }
  const ime = setup.ime
  if (!ime) return
  if (ime.switched) {
    info(
      `${style('  输入法', 'dim')} ${describeIme(ime.before)} → ${describeIme(ime.after)}` +
        ` ${style('（结束时自动还原）', 'dim')}`
    )
    return
  }
  if (ime.after && (ime.after.open || ime.after.native)) {
    info(
      style(`${mark('warn')} 目标窗口的输入法仍在合成状态（${describeIme(ime.after)}）`, 'warn') +
        '：打进来的帧可能被吃成候选上屏，建议手动切到英文后再开始'
    )
  }
}

/** @description 终端宽度变了：作废旧进度块的几何信息，按新宽度重排一次 */
function onResize(): void {
  setup.caps.columns = Number(process.stdout.columns ?? 0) || 80
  screen.forget()
  drawProgress(true)
}

/**
 * @description 主循环：先挂监听再读输入、分发帧，最后合并校验
 * @returns 退出码
 */
async function run(): Promise<number> {
  const splitter = createStreamSplitter()

  // 终端能力与输入法：Windows 下用一次**隐藏的** PowerShell 一起搞定
  // （UTF-8 代码页 + 开 ANSI + 必要时切英文直输），退出时再还原
  const wantIme =
    options.ime === 'on' ||
    (options.ime === 'auto' && options.input === null && process.stdin.isTTY === true)
  setup = prepareConsole({ ensureIme: wantIme })
  screen = new Screen(setup.caps, progressMode(), (text) => process.stdout.write(text))
  process.stdout.on('resize', onResize)
  reportConsoleSetup()

  // 指定了 --dir 且目录里有 meta.json：即使这次没有开始帧也能续传
  if (options.dir) {
    dir = resolve(options.dir)
    const loaded = loadMeta(dir)
    if (loaded) {
      try {
        applyMeta(loaded)
      } catch (error) {
        if (!(error instanceof LockBusyError)) throw error
        reportLockBusy(error.message)
        return EXIT.USAGE
      }
      const found = scanExistingParts()
      if (found > 0 && !quiet) {
        info(style(`续传：目录里已有 ${found}/${loaded.total} 片`, 'warn'))
      }
    }
  }

  /**
   * @description 逐条处理，并判断是否已收到结束帧
   * @param lines 待处理的行
   * @returns 是否应停止读取
   */
  const consume = (lines: string[]): boolean => {
    for (const line of lines) {
      if (lockBlocked) return true
      handleLine(line)
      if (pendingEnd) return true
    }
    return false
  }

  let ended = false
  const source = options.input ? createReadStream(resolve(options.input), 'utf8') : process.stdin

  if (!options.input) {
    if (process.stdin.isTTY && !options.cooked) {
      process.stdin.setRawMode(true)
      if (!quiet) info(style('（raw 模式：不回显、无行宽限制；Ctrl+C 中止）', 'dim'))
    }
    process.stdin.setEncoding('utf8')
  }

  /**
   * @description 输入流回调：处理 Ctrl+C / Ctrl+D 与普通数据
   * @param chunk 输入数据块
   */
  const onData = (chunk: string | Buffer): void => {
    if (lockBlocked) return
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
  if (lockBlocked) return EXIT.USAGE

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
      info(
        style(`! 忽略无法解析的行（${code}）`, 'warn') +
          `${detail}。若持续出现，请检查是否混入了终端回显或提示符。`
      )
    }
    return
  }

  try {
    if (frame.kind === 'begin') handleBegin(frame)
    else if (frame.kind === 'data') handleData(frame)
    else if (frame.kind === 'end') pendingEnd = frame
    else info(`提示：这是一条续传令（缺 ${formatIndexList(frame.missing, frame.total)}）。`)
  } catch (error) {
    if (error instanceof LockBusyError) {
      reportLockBusy(error.message)
      return
    }
    const code = error instanceof FrameError ? error.code : 'field'
    const seq = frame.kind === 'data' ? frame.seq : '-'
    ack(`#FAIL ${seq} ${code}`)
    if (seq !== '-') {
      failures.set(Number(seq), code)
      missing.add(Number(seq))
      done.delete(Number(seq))
    }
    info(
      `${style(`${mark('err')} 第 ${Number(seq) + 1} 片失败（${code}）`, 'err')}：` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `  → ${ERROR_HINTS[code] ?? '请重传该片'}`
    )
  }
}

// 退出前把输入法还原、锁释放：正常结束、Ctrl+C（cooked 模式）、未预期异常都要能覆盖。
// 还原走的是同步子进程，所以放在 exit 钩子里也能真的跑完。
process.on('exit', () => {
  restoreConsoleIme()
  releaseLock()
})
process.once('SIGINT', () => {
  restoreConsoleIme()
  screen.clear()
  releaseLock()
  process.exit(130)
})

run()
  .then((code) => {
    process.exit(typeof code === 'number' ? code : EXIT.OK)
  })
  .catch((error) => {
    info(`未预期的错误：${error instanceof Error ? error.stack : String(error)}`)
    process.exit(EXIT.USAGE)
  })
