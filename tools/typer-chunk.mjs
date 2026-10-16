#!/usr/bin/env node
// Typer 分片端（离线）：把文件切成"每片一行"的帧文本，产出帧文件 + manifest.json。
// 让"分片"可完全离线复现（不依赖 Electron 界面）：`--single` 产出的帧文本可直接粘到 Typer 的「文本」页，`--verify` 能在真实传输前按接收端规则重放校验。
// 只用 node: 内置模块、零第三方依赖，Node >= 18 直接运行（目标机不一定有构建环境）。
// 用法：node typer-chunk.mjs <文件> [选项]（`--help` 查看全部选项）

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_FRAME_CHARS,
  FRAME_VERSION,
  MAX_CHUNK_BYTES,
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  chunkCount,
  createLineSplitter,
  crc32Hex,
  decodeBytes,
  encodeBytes,
  escapeText,
  estimateDataFrameChars,
  parseFrame,
  planTextChunks,
  randomJobId,
  sanitizeLine,
  sha16Hex,
  unescapeText,
  verifyDataFrame
} from './lib/frame.mjs'

const MANIFEST_VERSION = 1

const HELP = `Typer 分片端（生成帧文本 + manifest）

用法：node typer-chunk.mjs <文件> [选项]

  -o, --out <dir>        输出目录（默认 ./.typer-chunks-<job>）
      --chunk <bytes>    每片原始字节数（默认 ${DEFAULT_CHUNK_BYTES}，上限 ${MAX_CHUNK_BYTES}）
      --enc <enc>        编码 hex | b64 | txt（默认 hex；txt 仅支持 UTF-8 文本）
      --name <name>      接收端使用的文件名（默认取源文件名）
      --job <id>         任务 id（8 位小写 hex，默认随机）
      --single <path>    额外输出合并后的帧文本（可直接粘贴到 Typer 文本页）
      --no-frames        只输出 manifest.json，不写每片的帧文件
      --no-frame-list    manifest 里不记录每片的 crc/sha（大文件可减小清单体积）
      --max-frame-chars  帧长上限校验（默认 ${DEFAULT_MAX_FRAME_CHARS}）
      --verify           生成后按接收端规则重新解析、逐片校验并合并比对整文件哈希
  -q, --quiet            只输出结果行
  -h, --help             显示本帮助
`

/**
 * @description 解析命令行参数（`--key value`、`--key=value`、`-k value` 与布尔开关）
 * @param argv 参数数组
 * @returns 选项表与位置参数
 */
function parseArgs(argv) {
  const options = {}
  const aliases = { o: 'out', q: 'quiet', h: 'help' }
  const flags = new Set(['no-frames', 'no-frame-list', 'verify', 'quiet', 'help'])
  const positional = []

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    if (!raw.startsWith('-')) {
      positional.push(raw)
      continue
    }
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
  return { options, positional }
}

const { options, positional } = parseArgs(process.argv.slice(2))

if (options.help || positional.length === 0) {
  process.stdout.write(HELP)
  process.exit(positional.length === 0 ? 4 : 0)
}

const quiet = options.quiet === true

/**
 * @description 非安静模式下打印一行到标准输出
 * @param line 行内容
 */
function log(line) {
  if (!quiet) process.stdout.write(`${line}\n`)
}

/**
 * @description 打印错误并以退出码 4 结束进程
 * @param message 错误说明
 */
function fail(message) {
  process.stderr.write(`错误：${message}\n`)
  process.exit(4)
}

const sourcePath = resolve(positional[0])
if (!existsSync(sourcePath)) fail(`文件不存在：${sourcePath}`)

const stat = statSync(sourcePath)
if (!stat.isFile()) fail(`不是普通文件：${sourcePath}`)

const enc = String(options.enc ?? 'hex')
if (!['hex', 'b64', 'txt'].includes(enc)) fail(`不支持的编码：${enc}`)
if (enc === 'txt') {
  // txt 只支持 UTF-8：只有"文件字节 == 该文本的 UTF-8 编码"时，整文件哈希才在两端一致
  log('提示：txt 编码按 UTF-8 处理；需要逐字节还原其它编码（如 GBK）时请用 hex 或 b64。')
}

const chunkBytes = Number(options.chunk ?? DEFAULT_CHUNK_BYTES)
if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
  fail(`片大小不合法：${String(options.chunk)}（1 ~ ${MAX_CHUNK_BYTES}）`)
}

const maxFrameChars = Number(options['max-frame-chars'] ?? DEFAULT_MAX_FRAME_CHARS)
if (!Number.isInteger(maxFrameChars) || maxFrameChars < 64) fail('帧长上限不合法')

const job = String(options.job ?? randomJobId())
if (!/^[0-9a-f]{4,16}$/.test(job)) fail(`任务 id 不合法：${job}`)

const size = stat.size
const name = String(options.name ?? basename(sourcePath))
const outDir = resolve(String(options.out ?? `.typer-chunks-${job}`))
const singlePath = options.single ? resolve(String(options.single)) : null

const sourceText = enc === 'txt' ? readWholeFileAsUtf8(sourcePath) : null

// txt 按**字符边界**切片，片长由字符决定，因此片数只能用同一套切分算出来；
// hex/b64 是纯字节切分，片数可以直接整除求出。
const textChunks =
  sourceText === null
    ? null
    : planTextChunks(sourceText, chunkBytes, (chunk) => Buffer.byteLength(chunk, 'utf8'))
const total = textChunks === null ? chunkCount(size, chunkBytes) : textChunks.length

// 帧长上限先算一次：超出就应该在生成之前失败，而不是打到一半才发现终端吞了内容
{
  const headerChars = estimateDataFrameChars({
    job,
    seq: Math.max(0, total - 1),
    total,
    bytes: 0,
    enc
  })
  const widest = Math.min(chunkBytes, size || chunkBytes)
  const payloadChars =
    textChunks === null
      ? enc === 'hex'
        ? widest * 2
        : Math.ceil(widest / 3) * 4
      : Math.max(0, ...textChunks.map((chunk) => escapeText(chunk.text).length))
  const frameChars = headerChars + payloadChars

  if (frameChars > maxFrameChars) {
    fail(
      `帧长约 ${frameChars} 字符，超过上限 ${maxFrameChars}。\n` +
        `  建议把 --chunk 降到 ${Math.max(
          1,
          Math.floor((maxFrameChars - headerChars) / (enc === 'hex' ? 2 : enc === 'b64' ? 1.34 : 1))
        )} 左右，或放宽 --max-frame-chars。`
    )
  }
}

mkdirSync(outDir, { recursive: true })

/**
 * @description 以 UTF-8 读取整个文件，并确认没有 BOM 且字节与文本一致（txt 编码的前提）
 * @param path 源文件路径
 * @returns 文件文本
 */
function readWholeFileAsUtf8(path) {
  const bytes = readFileSync(path)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail('txt 编码不接受带 BOM 的文件（字节与文本不再是同一份数据）；请改用 hex 或 b64。')
  }
  const text = bytes.toString('utf8')
  if (Buffer.byteLength(text, 'utf8') !== bytes.length) {
    fail('txt 编码要求文件是合法 UTF-8 文本；该文件不是，请改用 hex 或 b64。')
  }
  return text
}

/**
 * @description 计算整文件 SHA-256（流式读取，避免把大文件读进内存）
 * @returns 64 位小写 hex
 */
function computeWholeHash() {
  const fd = openSync(sourcePath, 'r')
  const buffer = Buffer.allocUnsafe(1 << 20)
  const hash = createHash('sha256')
  try {
    let position = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position)
      if (read <= 0) break
      hash.update(buffer.subarray(0, read))
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

const wholeSha = computeWholeHash()
log(`任务 ${job}：${name}，${size} 字节 → ${total} 片（${chunkBytes} 字节/片，${enc}）`)

const beginLine = buildBeginFrame({
  job,
  total,
  size,
  enc,
  chunk: chunkBytes,
  name,
  sha256: wholeSha
})
const endLine = buildEndFrame({ job, total, size, sha256: wholeSha })

const frames = []
let singleStream = null

if (!options['no-frames']) {
  writeFileSync(join(outDir, 'begin.txt'), `${beginLine}\n`)
  writeFileSync(join(outDir, 'end.txt'), `${endLine}\n`)
}

if (singlePath) {
  singleStream = []
}

/** @description 按片生成帧文本：读一片、算校验、立即写出，内存只占一个片 */
function generateFromBytes() {
  const fd = openSync(sourcePath, 'r')
  const buffer = Buffer.allocUnsafe(chunkBytes)
  try {
    for (let seq = 0; seq < total; seq++) {
      const expected = Math.min(chunkBytes, size - seq * chunkBytes)
      let filled = 0
      while (filled < expected) {
        const read = readSync(fd, buffer, filled, expected - filled, seq * chunkBytes + filled)
        if (read <= 0) break
        filled += read
      }
      const slice = buffer.subarray(0, filled)
      writeFrame(seq, slice)
    }
  } finally {
    closeSync(fd)
  }
}

/** @description txt 模式：按字符边界切分，保证每片的字节长度与其 UTF-8 编码一致 */
function generateFromText() {
  if (textChunks === null) throw new Error('txt 模式的片表缺失')
  textChunks.forEach((chunk, seq) =>
    writeFrame(seq, Buffer.from(chunk.text, 'utf8'), escapeText(chunk.text))
  )
}

/**
 * @description 构造并写出一片数据帧（同时记录清单条目）
 * @param seq 片号
 * @param bytes 本片字节
 * @param payloadOverride 已编码的载荷（txt 模式传入，省略则按 enc 编码）
 */
function writeFrame(seq, bytes, payloadOverride) {
  const payload = payloadOverride ?? encodeBytes(bytes, enc)
  const line = buildDataFrame({
    job,
    seq,
    total,
    bytes: bytes.length,
    crc32: crc32Hex(bytes),
    sha16: sha16Hex(bytes),
    enc,
    payload
  })

  if (line.length > maxFrameChars) {
    fail(`第 ${seq} 帧长 ${line.length} 超过上限 ${maxFrameChars}，请减小 --chunk`)
  }

  frames.push({ seq, bytes: bytes.length, crc32: crc32Hex(bytes), sha16: sha16Hex(bytes) })
  if (!options['no-frames'])
    writeFileSync(join(outDir, `${String(seq).padStart(6, '0')}.txt`), `${line}\n`)
  if (singleStream) singleStream.push(line)
}

if (enc === 'txt') generateFromText()
else generateFromBytes()

const manifest = {
  manifestVersion: MANIFEST_VERSION,
  version: FRAME_VERSION,
  job,
  name,
  size,
  sha256: wholeSha,
  enc,
  chunk: chunkBytes,
  total,
  maxFrameChars,
  createdAt: new Date().toISOString(),
  frames: options['no-frame-list'] ? undefined : frames
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

if (singleStream) {
  const text = [beginLine, ...singleStream, endLine].join('\n')
  writeFileSync(singlePath, `${text}\n`)
  log(`帧文本：${singlePath}（${text.length} 字符，可直接粘贴到 Typer 文本页）`)
}

log(`帧文件：${outDir}${options['no-frames'] ? '（未生成帧文件）' : ''}`)
log(`整文件 SHA-256：${wholeSha}`)

if (options.verify === true) {
  if (options['no-frames'] === true) fail('--verify 需要帧文件，不能与 --no-frames 一起使用')
  process.exitCode = verifyGenerated()
}

/**
 * @description 用接收端的规则把生成结果重新读一遍：逐片解析 + 校验，再合并比对整文件哈希；
 * 在"真机传输"之前就能证明帧文本本身无损（分片边界、编码、转义、校验字段都对）
 * @returns 退出码（0 通过，3 失败）
 */
function verifyGenerated() {
  const digest = createHash('sha256')
  let merged = 0
  let framesChecked = 0

  /**
   * @description 解析并校验一行帧，同时把数据字节喂给整文件哈希
   * @param line 待处理的帧行
   */
  const feed = (line) => {
    const frame = parseFrame(sanitizeLine(line))
    if (frame.kind === 'begin') {
      if (frame.job !== job || frame.total !== total) throw new Error('开始帧与生成参数不一致')
      return
    }
    if (frame.kind === 'end') {
      if (frame.sha256 !== wholeSha) throw new Error('结束帧哈希不一致')
      return
    }
    if (frame.kind !== 'data') return
    const bytes =
      frame.enc === 'txt'
        ? Buffer.from(unescapeText(frame.payload), 'utf8')
        : decodeBytes(frame.payload, frame.enc)
    verifyDataFrame(frame, bytes)
    digest.update(bytes)
    merged += bytes.length
    framesChecked += 1
  }

  try {
    for (const entry of frames) {
      const path = join(outDir, `${String(entry.seq).padStart(6, '0')}.txt`)
      if (!existsSync(path)) throw new Error(`缺少帧文件：${path}`)
      const splitter = createLineSplitter()
      for (const line of splitter.push(readFileSync(path, 'utf8'))) feed(line)
      for (const line of splitter.flush()) feed(line)
    }

    if (merged !== size) throw new Error(`合并后大小 ${merged}，期望 ${size}`)
    const actual = digest.digest('hex')
    if (actual !== wholeSha) {
      throw new Error(`整文件哈希不一致：期望 ${wholeSha}，实际 ${actual}`)
    }
  } catch (error) {
    process.stderr.write(`自检失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 3
  }

  log(`自检通过：${framesChecked} 片重新解析、逐片校验并合并后与源文件完全一致。`)
  return 0
}
