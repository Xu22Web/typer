#!/usr/bin/env node
// Typer 接收端：在**目标机**上运行（零依赖、Node >= 16，只用 node: 内置模块）：逐行读帧 → 逐片校验 → 原子落盘 → 断点续传 → 合并并校验整文件。
// 输入是键盘 / 剪贴板"打"进来的，可能丢字符或被行缓冲截断，因此每片必须自校验、TTY 下默认切 raw 模式；大文件逐片落盘、合并时流式哈希。
// 线格式实现引用主进程的 src/main/util/frame.ts，收发两端共用同一份代码；本文件由 esbuild 打成单文件 tools/typer-recv.mjs 后分发。
// 用法见 tools/README.md（`--help` 查看全部选项，`--selftest` 先自检环境）。

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  ERROR_HINTS,
  FRAME_VERSION,
  FrameError,
  buildResumeToken,
  chunkSlice,
  createLineSplitter,
  crc32Hex,
  decodeBytes,
  escapeText,
  formatIndexList,
  missingIndexes,
  parseFrame,
  parseIndexList,
  sanitizeLine,
  sha256Hex,
  unescapeText,
  verifyDataFrame
} from '../src/main/util/frame'
import type {
  FrameEncoding,
  ParsedBeginFrame,
  ParsedDataFrame,
  ParsedEndFrame,
  ParsedResumeFrame
} from '../src/main/util/frame'

const EXIT = { OK: 0, INCOMPLETE: 2, BAD: 3, USAGE: 4, INTERRUPTED: 130 }
const REPORT_VERSION = 1

const HELP = `Typer 文件接收端（逐片校验 + 断点续传 + 合并校验）

用法：node typer-recv.mjs [选项]

  -o, --out <path>        输出文件（默认用开始帧里的文件名，否则 job-<id>.bin）
  -d, --dir <path>        分片工作目录（默认 ./.typer-<job>）
      --in <file>         从文件读取帧（默认读标准输入）
      --cooked            强制行缓冲读入（TTY 下默认是 raw：不回显、无行宽限制）
      --no-resume         忽略已有分片，全部重收（默认：校验通过即跳过）
      --force             允许覆盖已存在的输出文件
      --report <path>     续传报告 JSON 路径（默认 <dir>/resume.json；写 "-" 关闭）
      --token             结束时（数据不全）额外打印可回填 Typer 的续传令牌
      --ack <target>      回执输出到 stdout | stderr | none（默认 stdout）
      --progress-every <n> 每 n 片打印一次 #OK（默认 1；0 表示只打印失败）
      --keep-parts        合并成功后保留分片目录
      --charset <cs>      txt 编码的写盘编码（默认 utf-8）
  -q, --quiet             只在失败 / 续传摘要 / 最终结果时输出
  -v, --verbose           输出额外诊断信息
      --selftest          只跑内置自检（校验 CRC、编码、片号解析）后退出
  -h, --help              显示本帮助

退出码：0 成功并校验通过 / 2 数据不全 / 3 完整性校验失败 / 4 参数或 IO 错误
`

/**
 * @description 解析 `--key value`、`--key=value`、`-k value` 与布尔开关
 * @param argv 参数数组
 * @returns 选项表
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {}
  const aliases: Record<string, string> = {
    o: 'out',
    d: 'dir',
    q: 'quiet',
    v: 'verbose',
    h: 'help'
  }
  const flags = new Set([
    'cooked',
    'no-resume',
    'force',
    'token',
    'keep-parts',
    'quiet',
    'verbose',
    'selftest',
    'help'
  ])

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    if (!raw.startsWith('-')) continue
    const stripped = raw.replace(/^--?/, '')
    const equals = stripped.indexOf('=')
    const name = equals >= 0 ? stripped.slice(0, equals) : stripped
    const key = aliases[name] ?? name
    if (!flags.has(key) && equals < 0) {
      options[key] = argv[index + 1]
      index += 1
    } else if (equals >= 0) {
      options[key] = stripped.slice(equals + 1)
    } else {
      options[key] = true
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(HELP)
  process.exit(EXIT.OK)
}

if (options.selftest) {
  process.exit(runSelfTest())
}

/**
 * @description 内置自检：确认这台机器上的 Node 至少能正确完成"编码 → 校验 → 解码 → 片号解析"；
 * 目标机环境不可控（老版本 Node、异常 locale），先跑一遍能省掉大量无谓排查
 * @returns 退出码（0 全部通过，3 有失败项）
 */
function runSelfTest(): number {
  const checks: Array<{ name: string; ok: boolean }> = []
  /**
   * @description 记录一项自检结果
   * @param name 检查项名称
   * @param condition 是否通过
   */
  const check = (name: string, condition: unknown): void => {
    checks.push({ name, ok: Boolean(condition) })
  }

  try {
    check('CRC32 标准向量', crc32Hex('123456789') === 'cbf43926')
    check(
      'SHA-256 标准向量',
      sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
    const bytes = Uint8Array.from([0, 1, 127, 128, 255])
    check('hex 往返', [...decodeBytes(crc32SafeEncode(bytes), 'hex')].join() === [...bytes].join())
    check('base64 往返', [...decodeBytes(encodeB64(bytes), 'b64')].join() === [...bytes].join())
    check('文本转义往返', unescapeText(escapeText('a\r\n\t\\b\u0000中')) === 'a\r\n\t\\b\u0000中')
    check('片号解析', parseIndexList('1,3-5', 10).join() === '1,3,4,5')
    check(
      '帧解析',
      (parseFrame('@TYPER1/R a1b2c3d4 10 3-5') as ParsedResumeFrame).missing.join() === '3,4,5'
    )
    check('帧版本', FRAME_VERSION === 1)
  } catch (error) {
    check(`自检异常：${error instanceof Error ? error.message : String(error)}`, false)
  }

  const failed = checks.filter((item) => !item.ok)
  for (const item of checks) {
    process.stdout.write(`${item.ok ? '  ok  ' : ' FAIL '}${item.name}\n`)
  }
  process.stdout.write(
    failed.length === 0
      ? `自检通过（Node ${process.version}，${process.platform}）\n`
      : `自检失败：${failed.length} 项\n`
  )
  return failed.length === 0 ? EXIT.OK : EXIT.BAD
}

/**
 * @description 把字节编码成十六进制文本（自检用，不依赖被测实现本身）
 * @param bytes 字节序列
 * @returns 大写十六进制文本
 */
function crc32SafeEncode(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0').toUpperCase()
  return out
}

/**
 * @description 把字节编码成 base64 文本（自检用）
 * @param bytes 字节序列
 * @returns base64 文本
 */
function encodeB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const ackTarget =
  options.ack === 'none' ? null : options.ack === 'stderr' ? process.stderr : process.stdout

/**
 * @description 按 --ack 设置输出一行回执
 * @param line 回执内容
 */
function ack(line: string): void {
  if (ackTarget) ackTarget.write(`${line}\n`)
}

/**
 * @description 输出一行诊断信息到标准错误
 * @param line 信息内容
 */
function info(line: string): void {
  process.stderr.write(`${line}\n`)
}

// ---------------------------------------------------------------------------
// 任务状态
// ---------------------------------------------------------------------------

const quiet = options.quiet === true
const verbose = options.verbose === true
const resume = options['no-resume'] !== true
const progressEvery = Number(options['progress-every'] ?? 1)
const charset = String(options.charset ?? 'utf-8')

/** 当前任务的元信息（来自开始帧，或断点续传时从工作目录的 meta.json 恢复）。 */
interface TaskMeta {
  job: string
  total: number
  size: number
  sha256: string
  enc: FrameEncoding
  chunk: number
  name: string | null
  charset?: string
}

let meta: TaskMeta | null = null
let dir: string | null = options.dir ? resolve(String(options.dir)) : null
let outPath: string | null = options.out ? resolve(String(options.out)) : null
const reportDisabled = options.report === '-'
let reportPath = options.report && !reportDisabled ? resolve(String(options.report)) : null
let seqWidth = 6

const done = new Set<number>()
const missing = new Set<number>()
const failures = new Map<number, string>()
let noiseLines = 0
let receivedFrames = 0
let lastReportAt = 0

/**
 * @description 生成分片文件名（带 crc，存在即可校验，无需额外 sidecar）
 * @param seq 片号
 * @param crc 该片 crc32 文本
 * @returns 分片文件名
 */
function partName(seq: number, crc: string): string {
  return `part-${String(seq).padStart(seqWidth, '0')}-${crc}.bin`
}

/**
 * @description 生成分片文件的完整路径
 * @param seq 片号
 * @param crc 该片 crc32 文本
 * @returns 分片文件路径
 */
function partPath(seq: number, crc: string): string {
  return join(dir as string, partName(seq, crc))
}

/**
 * @description 计算第 seq 片应有的字节数
 * @param seq 片号
 * @returns 字节数；txt 模式片长由字符决定、无法反推，返回 null
 */
function expectedBytes(seq: number): number | null {
  // txt 模式按字符边界切片，片长由字符决定，无法用字节数反推（只能校验上界）
  if (meta!.enc === 'txt') return null
  return chunkSlice(meta!.size, meta!.chunk, seq).bytes
}

/**
 * @description 校验数据帧声明的片长度是否符合预期
 * @param frame 已解析的数据帧
 */
function assertChunkLength(frame: ParsedDataFrame): void {
  const expected = expectedBytes(frame.seq)
  if (expected === null) {
    if (frame.bytes < 1 || frame.bytes > meta!.chunk) {
      throw new FrameError('len', `片 ${frame.seq} 长度 ${frame.bytes} 超出 1 ~ ${meta!.chunk}`)
    }
    return
  }
  if (frame.bytes !== expected) {
    throw new FrameError('len', `片 ${frame.seq} 长度应为 ${expected}，帧里声明 ${frame.bytes}`)
  }
}

/**
 * @description 读取工作目录里的 meta.json
 * @returns 元信息对象；不存在或损坏时返回 null
 */
function loadMeta(): TaskMeta | null {
  const metaPath = join(dir as string, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (parsed && typeof parsed.job === 'string' && Number.isInteger(parsed.total)) return parsed
  } catch {
    // 坏掉的 meta 视为不存在（会有明确报错）
  }
  return null
}

/** @description 把当前任务元信息写入工作目录的 meta.json */
function saveMeta(): void {
  mkdirSync(dir as string, { recursive: true })
  writeFileSync(
    join(dir as string, 'meta.json'),
    JSON.stringify(
      {
        reportVersion: REPORT_VERSION,
        version: FRAME_VERSION,
        job: meta!.job,
        total: meta!.total,
        size: meta!.size,
        sha256: meta!.sha256,
        enc: meta!.enc,
        chunk: meta!.chunk,
        name: meta!.name,
        charset,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  )
}

/**
 * @description 写续传报告（默认节流，避免每片都落盘）
 * @param force 是否忽略节流立即写入
 */
function writeReport(force = false): void {
  if (!reportPath || !meta) return
  const now = Date.now()
  if (!force && now - lastReportAt < 150) return
  lastReportAt = now
  const missingList = missingIndexes(meta.total, [...done])
  const payload = {
    reportVersion: REPORT_VERSION,
    version: FRAME_VERSION,
    job: meta.job,
    total: meta.total,
    size: meta.size,
    sha256: meta.sha256,
    enc: meta.enc,
    chunk: meta.chunk,
    name: meta.name,
    out: outPath,
    done: done.size,
    doneRanges: formatIndexList([...done], meta.total),
    missing: formatIndexList(missingList, meta.total)
  }
  try {
    mkdirSync(dir as string, { recursive: true })
    const tmp = `${reportPath}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2))
    renameSync(tmp, reportPath)
  } catch (error) {
    info(`警告：写入续传报告失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @description 应用任务元信息；已有任务时校验 job 是否一致
 * @param next 新的元信息
 * @param fromDisk 是否来自磁盘恢复（false 时回写 meta.json）
 * @returns 是否首次建立任务
 */
function applyMeta(next: TaskMeta, { fromDisk }: { fromDisk: boolean }): boolean {
  if (meta) {
    if (meta.job !== next.job) {
      throw new FrameError('job', `任务 id 不一致：当前 ${meta.job}，收到 ${next.job}`)
    }
    return false
  }
  meta = next
  dir = dir ?? resolve(`.typer-${meta.job}`)
  outPath = outPath ?? resolve(meta.name ? basename(meta.name) : `job-${meta.job}.bin`)
  if (!reportDisabled) reportPath = reportPath ?? join(dir, 'resume.json')
  seqWidth = Math.max(6, String(Math.max(0, meta.total - 1)).length)
  if (!fromDisk) saveMeta()
  return true
}

/**
 * @description 扫描已有分片并纳入续传状态；文件名里带 CRC，因此"存在即可校验"、无需 sidecar，
 * 校验不通过的旧分片会被删除，避免把坏数据当成已完成
 * @returns 保留的已完成片数
 */
function scanExistingParts(): number {
  if (!resume || !existsSync(dir as string)) return 0
  let kept = 0
  for (const entry of readdirSync(dir as string)) {
    const match = /^part-(\d+)-([0-9a-f]{8})\.bin$/.exec(entry)
    if (!match) continue
    const seq = Number(match[1])
    const crc = match[2]
    const full = join(dir as string, entry)
    if (seq >= meta!.total) {
      rmSync(full, { force: true })
      continue
    }
    const size = statSync(full).size
    const expected = expectedBytes(seq)
    const usable = expected === null ? size >= 1 && size <= meta!.chunk : size === expected
    if (!usable || crc32Hex(readFileSync(full)) !== crc) {
      if (verbose) info(`丢弃不可用的分片：${entry}`)
      rmSync(full, { force: true })
      continue
    }
    done.add(seq)
    kept += 1
  }
  return kept
}

// ---------------------------------------------------------------------------
// 单帧处理
// ---------------------------------------------------------------------------

/**
 * @description 处理开始帧：建立任务并列出缺失片
 * @param frame 已解析的开始帧
 */
function handleBegin(frame: ParsedBeginFrame): void {
  const fresh = applyMeta(
    {
      job: frame.job,
      total: frame.total,
      size: frame.size,
      sha256: frame.sha256,
      enc: frame.enc,
      chunk: frame.chunk,
      name: frame.name
    },
    { fromDisk: false }
  )

  if (fresh) {
    const kept = scanExistingParts()
    ack(
      `#BEGIN ${meta!.job} ${meta!.total} ${meta!.size} enc=${meta!.enc} chunk=${meta!.chunk} name=${
        meta!.name ?? '-'
      }`
    )
    if (kept > 0) ack(`#RESUME ${meta!.job} 已完成 ${kept}/${meta!.total}`)
    for (let seq = 0; seq < meta!.total; seq++) {
      if (!done.has(seq)) missing.add(seq)
    }
  }
  writeReport(true)
}

/**
 * @description 处理数据帧：校验后原子落盘
 * @param frame 已解析的数据帧
 */
function handleData(frame: ParsedDataFrame): void {
  receivedFrames += 1

  if (!meta) {
    // 续传场景：只发数据帧，没有开始帧 → 从工作目录里的 meta.json 恢复
    if (!dir) dir = resolve(`.typer-${frame.job}`)
    const disk = loadMeta()
    if (!disk) {
      throw new FrameError('job', `缺少开始帧，且 ${dir} 下没有 meta.json，无法判断任务规模`)
    }
    applyMeta(disk, { fromDisk: true })
    scanExistingParts()
    for (let seq = 0; seq < meta!.total; seq++) {
      if (!done.has(seq)) missing.add(seq)
    }
  }

  if (frame.job !== meta!.job) {
    throw new FrameError('job', `帧属于任务 ${frame.job}，当前任务是 ${meta!.job}`)
  }
  if (frame.total !== meta!.total) {
    throw new FrameError('job', `片总数不一致：期望 ${meta!.total}，帧里是 ${frame.total}`)
  }
  if (frame.seq >= meta!.total) {
    throw new FrameError('range', `片号超出总数：${frame.seq}/${meta!.total}`)
  }
  if (frame.enc !== meta!.enc) {
    throw new FrameError('enc', `编码不一致：期望 ${meta!.enc}，帧里是 ${frame.enc}`)
  }

  assertChunkLength(frame)

  const bytes = decodeDataPayload(frame)
  verifyDataFrame(frame, bytes)

  const target = partPath(frame.seq, frame.crc32)
  if (done.has(frame.seq)) {
    // 幂等：已校验通过的片再收到一次不改变结果
    if (existsSync(target) && verbose) info(`重复片 ${frame.seq}（已存在且校验通过）`)
    if (!quiet && verbose) ack(`#SKIP ${frame.seq}`)
    return
  }

  mkdirSync(dir as string, { recursive: true })
  const tmp = `${target}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, target)

  done.add(frame.seq)
  missing.delete(frame.seq)

  if (!quiet && (progressEvery === 0 ? false : receivedFrames % Math.max(1, progressEvery) === 0)) {
    ack(`#OK ${frame.seq} ${done.size}/${meta!.total} ${bytes.length}`)
  }
  writeReport()
}

/**
 * @description 把数据帧载荷解码为字节
 * @param frame 已解析的数据帧
 * @returns 解码后的字节
 */
function decodeDataPayload(frame: ParsedDataFrame): Uint8Array {
  if (frame.enc === 'txt')
    return Buffer.from(unescapeText(frame.payload), charset as BufferEncoding)
  return decodeBytes(frame.payload, frame.enc)
}

// ---------------------------------------------------------------------------
// 合并与最终校验
// ---------------------------------------------------------------------------

/**
 * @description 合并分片并做整文件校验
 * @returns 退出码
 */
async function mergeAndVerify(): Promise<number> {
  const missingList = missingIndexes(meta!.total, [...done])
  if (missingList.length > 0) {
    const ranges = formatIndexList(missingList, meta!.total)
    ack(`#MISS ${ranges}`)
    if (options.token)
      ack(buildResumeToken({ job: meta!.job, total: meta!.total, missing: missingList }))
    writeReport(true)
    info(
      `数据不全：还缺 ${missingList.length}/${meta!.total} 片（${ranges}）。\n` +
        '把上面的片号填回 Typer 的「只发指定片」，或直接重跑一遍（已通过的片会自动跳过）。'
    )
    return EXIT.INCOMPLETE
  }

  if (existsSync(outPath as string) && options.force !== true) {
    info(
      `输出文件已存在：${outPath}\n` +
        '如需覆盖请加 --force（校验通过的结果不会被半成品覆盖，因此这里必须显式确认）。'
    )
    return EXIT.USAGE
  }

  const tmpOut = `${outPath}.part`
  const hash = createHash('sha256')
  let size = 0

  // 目录只扫一次：片数上万时逐片 readdir 会变成 O(n²)
  const parts = new Map<number, string>()
  for (const entry of readdirSync(dir as string)) {
    const match = /^part-(\d+)-([0-9a-f]{8})\.bin$/.exec(entry)
    if (match) parts.set(Number(match[1]), entry)
  }

  try {
    const out = createWriteStream(tmpOut)
    for (let seq = 0; seq < meta!.total; seq++) {
      const entry = parts.get(seq)
      if (!entry) throw new Error(`分片缺失：${seq}`)
      for await (const chunk of createReadStream(join(dir as string, entry))) {
        hash.update(chunk)
        size += chunk.length
        if (!out.write(chunk)) await once(out, 'drain')
      }
    }
    await new Promise<void>((ok, bad) => out.end((error) => (error ? bad(error) : ok())))
  } catch (error) {
    info(`合并失败：${error instanceof Error ? error.message : String(error)}`)
    return EXIT.USAGE
  }

  const digest = hash.digest('hex')
  if (size !== meta!.size || digest !== meta!.sha256) {
    rmSync(tmpOut, { force: true })
    ack(`#BAD 合并后校验失败（大小 ${size}/${meta!.size}，sha256 ${digest.slice(0, 16)}…）`)
    info(
      '完整性校验未通过。请重跑一次（分片已通过逐片校验，通常是合并阶段磁盘或权限问题），' +
        '或用 --keep-parts 保留分片以便进一步排查。'
    )
    return EXIT.BAD
  }

  renameSync(tmpOut, outPath as string)
  ack(`#DONE ${outPath} ${size} ${digest}`)
  if (!quiet) {
    info(`完成：${meta!.total} 片 → ${outPath}（${size} 字节），整文件 SHA-256 校验通过。`)
  }
  if (options['keep-parts'] !== true) {
    rmSync(dir as string, { recursive: true, force: true })
    reportPath = null
  } else {
    writeReport(true)
  }
  return EXIT.OK
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * @description 处理一行输入：解析成帧并按类型分发，无法解析的行按噪声忽略
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
    else if (frame.kind === 'resume') {
      info(
        `提示：这是一条续传令（缺 ${formatIndexList(frame.missing, frame.total)}），请回填到 Typer。`
      )
    } else if (frame.kind === 'end') {
      pendingEnd = frame
    }
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

let pendingEnd: ParsedEndFrame | null = null

/**
 * @description 主循环：先挂监听再读输入、分发帧，最后合并校验
 * @returns 退出码
 */
async function run(): Promise<number> {
  const splitter = createLineSplitter()

  /**
   * @description 逐行处理，并判断是否已收到结束帧
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
  /** 先在完整的输入流上挂监听，再 resume：先 resume 会让"无人接收"的数据被丢弃。 */
  const source = options.in ? createReadStream(String(options.in), 'utf8') : process.stdin
  let interrupted = false

  if (!options.in) {
    if (process.stdin.isTTY && options.cooked !== true) {
      process.stdin.setRawMode(true)
      if (!quiet) info('（raw 模式：不回显、无行宽限制；按 Ctrl+C 中止）')
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
      interrupted = true
      ended = true
      source.destroy()
      return
    }
    if (text.includes('\u0004')) {
      // raw 模式下的 Ctrl+D：当作输入结束
      if (consume(splitter.push(text.slice(0, text.indexOf('\u0004'))))) ended = true
      source.destroy()
      return
    }
    if (consume(splitter.push(text))) ended = true
  }

  source.on('data', onData)
  source.resume()

  await new Promise<void>((resolvePromise) => {
    /** @description 结束等待 */
    const finish = (): void => resolvePromise()
    source.on('end', finish)
    source.on('close', finish)
    source.on('error', (error) => {
      info(`读取输入失败：${error.message}`)
      finish()
    })
  })

  if (!ended) consume(splitter.flush())

  if (interrupted) {
    info('已中止（Ctrl+C）。已通过校验的分片仍然保留，重跑即可续传。')
    writeReport(true)
    return EXIT.INTERRUPTED
  }

  if (!meta) {
    info('没有收到任何有效帧。请确认输入流里是 Typer 生成的帧（每行一片）。')
    return noiseLines > 0 ? EXIT.INCOMPLETE : EXIT.USAGE
  }

  if (pendingEnd) {
    if (pendingEnd.job !== meta.job) {
      ack(`#FAIL - job`)
      info(`结束帧属于任务 ${pendingEnd.job}，当前任务是 ${meta.job}。`)
    } else if (pendingEnd.sha256 !== meta.sha256 || pendingEnd.size !== meta.size) {
      ack(`#FAIL - field`)
      info('结束帧的整文件哈希/大小与开始帧不一致：可能混入了另一次任务的数据。')
    }
  }

  const missingList = missingIndexes(meta.total, [...done])
  if (missingList.length > 0) return mergeAndVerify()

  if (!pendingEnd) {
    info('未收到结束帧，但所有分片都已通过逐片校验，继续按开始帧的哈希合并校验。')
  }

  return mergeAndVerify()
}

run()
  .then((code) => {
    process.exit(typeof code === 'number' ? code : EXIT.OK)
  })
  .catch((error) => {
    info(`未预期的错误：${error instanceof Error ? error.stack : String(error)}`)
    process.exit(EXIT.USAGE)
  })
