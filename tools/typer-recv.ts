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
 * 零第三方依赖，只用 node: 内置模块，Node >= 16 可运行。
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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
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
    else if (arg === '-q' || arg === '--quiet') options.quiet = true
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

/** 打印普通信息（quiet 时静默）。 */
function info(line: string): void {
  if (quiet) return
  process.stdout.write(`${line}\n`)
}

/** 打印回执行（`#` 前缀，Typer 与操作者约定的输出格式）。 */
function ack(line: string): void {
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
  if (verbose) {
    info(
      `任务 ${frame.job}：${frame.total} 片，${frame.size} 字节，` +
        `${frame.alphabet}/${frame.compression}/${frame.mode}` +
        (found > 0 ? `，续传已有 ${found} 片` : '')
    )
  }
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

  if (options.probe) return

  const target = partPath(frame.seq, frame.crc32)
  // 同名分片已存在（同片同 CRC）→ 跳过，整批重放也不会重复写盘
  if (existsSync(target)) return

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
      `数据不全：还缺 ${missingList.length}/${task.total} 片（${formatIndexList(
        missingList,
        task.total
      )}）。\n  → 在 Typer 里粘贴上面的 @T2R 令牌，只补这些片即可；已收到的分片全部保留。`
    )
    return EXIT.INCOMPLETE
  }

  const crcs = collectPartCrcs()
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
    try {
      rmSync(outputPath, { force: true })
    } catch {
      // 删不掉也不影响错误提示
    }
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
      try {
        rmSync(join(dir, entry), { recursive: true, force: true })
      } catch {
        // 清理失败不影响结果
      }
    }
  } else {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结果
    }
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
  if (!quiet) info(`完成：${outputPath}（${task.size} 字节，SHA-256 已校验）`)
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
      info(`忽略无法解析的行（${code}）。若持续出现，请检查是否混入了终端回显或提示符。`)
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
