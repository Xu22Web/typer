import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBeginFrame,
  buildDataFrame,
  buildEndFrame,
  chunkCount,
  chunkSlice,
  crc32Hex,
  encodeBytes,
  escapeText,
  parseFrame,
  planTextChunks,
  randomJobId,
  sha16Hex,
  sha256Hex,
  type FrameEncoding
} from '@main/util/frame'
import { prepareTransfer, type PreparedTransfer } from '@main/transfer/prepare'
import { matchResume, parseResumeState } from '@main/transfer/resume'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/**
 * @description 定位接收端构建产物；产物由 `npm run build:tools`（源码 tools/typer-recv.ts）打包生成，
 * 缺失时必须明确报错——静默跳过会让"接收端坏了"看起来像"测试通过"
 * @param name 产物文件名
 * @returns 产物绝对路径
 */
function toolPath(name: string): string {
  const path = join(root, 'tools', name)
  if (!existsSync(path)) {
    throw new Error(
      `缺少接收端构建产物 ${path}：请先运行 npm run build:tools（由 tools/typer-recv.ts 打包生成）`
    )
  }
  return path
}

const RECV = toolPath('typer-recv.mjs')

/**
 * @description 通过 cmd 运行 tools/run.bat：验证"目标机双击这个文件"真的能启动接收端。
 * 用 spawn 显式把 stdin 设成 ignore —— 接收端在没给 `--in` 时会一直等标准输入，测试里必须立刻给它 EOF
 * @param args 传给 run.bat 的参数
 * @returns 退出码与 stdout/stderr
 */
function runBat(args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', toolPath('run.bat'), ...args],
      { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.on('error', () => resolve({ code: -1, stdout, stderr }))
  })
}

interface ToolResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * @description 真实启动脚本进程并收集输出；这里要验证的正是"跨进程、跨脚本"的行为，不做任何模拟
 * @param script 脚本路径
 * @param args 脚本参数
 * @param cwd 工作目录
 * @returns 退出码与 stdout/stderr
 */
async function runTool(script: string, args: string[], cwd: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

let work: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'typer-tool-'))
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/**
 * @description 生成确定性源文件，含 0x00/0xFF/CRLF/Ctrl+Z 等"会捣乱"的字节
 * @param size 字节数
 * @param seed 随机种子
 * @returns 源文件内容
 */
function makeSource(size: number, seed = 5): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    buffer[index] = index % 37 === 0 ? 0 : (state >>> 16) & 0xff
  }
  // 混入 CRLF 与 0x1a(Ctrl+Z)：这些是"原始字节注入"会失败的原因
  buffer.write('\r\n\u001a', 0, 'latin1')
  return buffer
}

interface FrameSet {
  job: string
  sha256: string
  total: number
  lines: string[]
}

/**
 * @description 用应用侧的线格式实现生成一份帧文本（模拟 Typer 发送端）
 * @param sourcePath 相对于 work 的源文件路径
 * @param options 片大小、编码与写进开始帧的文件名
 * @returns 帧集合（开始帧、数据帧、结束帧与任务摘要）
 */
function buildFrames(
  sourcePath: string,
  options: { chunk?: number; enc?: FrameEncoding; name?: string } = {}
): FrameSet {
  const enc = options.enc ?? 'hex'
  const chunk = options.chunk ?? 1024
  const source = readFileSync(join(work, sourcePath))
  const job = randomJobId()
  const size = source.length
  const sha256 = sha256Hex(source)

  const textChunks = enc === 'txt' ? planTextChunks(source.toString('utf8'), chunk) : null
  const total = textChunks === null ? chunkCount(size, chunk) : textChunks.length

  const lines = [
    buildBeginFrame({
      job,
      total,
      size,
      enc,
      chunk,
      name: options.name ?? basename(sourcePath),
      sha256
    })
  ]

  /**
   * @description 构造并记录一片数据帧
   * @param seq 片号
   * @param part 本片字节
   * @param payload 已编码的单行载荷
   */
  const pushDataFrame = (seq: number, part: Uint8Array, payload: string): void => {
    lines.push(
      buildDataFrame({
        job,
        seq,
        total,
        bytes: part.length,
        crc32: crc32Hex(part),
        sha16: sha16Hex(part),
        enc,
        payload
      })
    )
  }

  if (textChunks === null) {
    for (let seq = 0; seq < total; seq++) {
      const slice = chunkSlice(size, chunk, seq)
      const part = source.subarray(slice.offset, slice.offset + slice.bytes)
      pushDataFrame(seq, part, encodeBytes(part, enc))
    }
  } else {
    textChunks.forEach((entry, seq) => {
      const part = Buffer.from(entry.text, 'utf8')
      pushDataFrame(seq, part, escapeText(entry.text))
    })
  }

  lines.push(buildEndFrame({ job, total, size, sha256 }))
  writeFileSync(join(work, 'frames.txt'), `${lines.join('\n')}\n`)

  return { job, sha256, total, lines }
}

/**
 * @description 把若干行帧文本写成文件，模拟"只发了一部分"
 * @param name 文件名
 * @param lines 帧行
 * @returns 文件路径
 */
function writeSubset(name: string, lines: string[]): string {
  const path = join(work, name)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('typer-recv.mjs：端到端接收与完整性校验', () => {
  it('--selftest 通过（目标机环境自检）', async () => {
    const result = await runTool(RECV, ['--selftest'], work)
    expect(result.stdout).toContain('自检通过')
    expect(result.code).toBe(0)
  })

  it('hex 编码的二进制文件逐字节还原，退出码 0', async () => {
    const source = makeSource(70000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin')

    const result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('#DONE')
    expect(result.code).toBe(0)
    expect(sha256Hex(readFileSync(join(work, 'out.bin')))).toBe(job.sha256)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('空文件也能完成（0 片，产出空文件）', async () => {
    writeFileSync(join(work, 'empty.bin'), Buffer.alloc(0))
    buildFrames('empty.bin')

    const result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-o', 'empty.out', '-d', 'work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'empty.out')).length).toBe(0)
  })

  it('b64 与 txt 编码同样逐字节还原', async () => {
    const binary = makeSource(4000)
    writeFileSync(join(work, 'src2.bin'), binary)
    buildFrames('src2.bin', { chunk: 333, enc: 'b64' })
    let result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-o', 'b64.out', '-d', 'work-b64', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'b64.out')).equals(binary)).toBe(true)

    // txt：UTF-8 文本（含中文、CRLF、Tab）
    const text = `第一行\r\n第二行\tTab\r\n中文与 emoji 😀\r\n`
    const textBuffer = Buffer.from(text, 'utf8')
    writeFileSync(join(work, 'note.txt'), textBuffer)
    buildFrames('note.txt', { chunk: 16, enc: 'txt' })
    result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-o', 'txt.out', '-d', 'work-txt', '--quiet'],
      work
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'txt.out')).equals(textBuffer)).toBe(true)
  })
})

describe('typer-recv.mjs：坏数据与断点续传', () => {
  it('篡改一帧 → 只有该片失败，退出码 2 并给出缺失片号；补传该片后完成', async () => {
    const source = makeSource(20000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin')

    // 破坏第 5 片载荷里的一个字符（长度不变，只是内容变了）
    const broken = [...job.lines]
    const target = broken[6] as string
    const marker = target.lastIndexOf(' ') + 1
    const mutated = target[marker] === 'A' ? 'B' : 'A'
    broken[6] = `${target.slice(0, marker)}${mutated}${target.slice(marker + 1)}`
    writeSubset('broken.txt', broken)

    const first = await runTool(
      RECV,
      ['--in', 'broken.txt', '-o', 'out.bin', '-d', 'work', '--quiet', '--token'],
      work
    )
    expect(first.stdout).toContain('#FAIL 5')
    expect(first.stdout).toContain('#MISS 5')
    expect(first.code).toBe(2)

    // 续传令可被解析（Typer 就是靠它回填缺失片）
    const tokenLine = first.stdout.split('\n').find((line) => line.startsWith('@TYPER1/R'))
    expect(tokenLine).toBeTruthy()
    const token = parseFrame(tokenLine as string)
    if (token.kind !== 'resume') throw new Error('应为续传令')
    expect(token.missing).toEqual([5])

    // 只补这一片（不带开始帧）：接收端从工作目录恢复任务信息
    writeSubset('retry.txt', [job.lines[6] as string])
    const second = await runTool(
      RECV,
      ['--in', 'retry.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(second.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('中断后续传：只发前一半 → 报告缺失片；再发剩下的（无开始帧）→ 完成且逐字节一致', async () => {
    const source = makeSource(30000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin')
    const half = Math.floor(job.total / 2)

    writeSubset('part1.txt', job.lines.slice(0, half + 1))
    const first = await runTool(RECV, ['--in', 'part1.txt', '-d', 'work', '--quiet'], work)
    expect(first.code).toBe(2)
    expect(first.stdout).toContain('#MISS')

    const report = JSON.parse(readFileSync(join(work, 'work', 'resume.json'), 'utf8'))
    expect(report.job).toBe(job.job)
    expect(report.done).toBe(half)
    expect(report.missing).toBe(`${half}-${job.total - 1}`)
    expect(report.sha256).toBe(job.sha256)

    // 第二批：数据帧 + 结束帧（不含开始帧）
    writeSubset('part2.txt', job.lines.slice(half + 1))
    const second = await runTool(
      RECV,
      ['--in', 'part2.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('#DONE')
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('幂等：重复收同一批帧不会破坏结果（已通过的分片会被跳过）', async () => {
    const source = makeSource(8000)
    writeFileSync(join(work, 'src.bin'), source)
    buildFrames('src.bin')

    const first = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin', '--keep-parts'],
      work
    )
    expect(first.code).toBe(0)

    // 保留分片：再收一遍时应当全部命中已校验通过的分片（#RESUME + 不重写）
    const second = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--keep-parts'],
      work
    )
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('#RESUME')
    expect(second.stdout).not.toContain('#OK')
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('--no-resume 时忽略已有分片并全部重收', async () => {
    const source = makeSource(4000)
    writeFileSync(join(work, 'src.bin'), source)
    buildFrames('src.bin')

    await runTool(RECV, ['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin'], work)
    const forced = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--no-resume'],
      work
    )
    expect(forced.stdout).toContain('#OK')
    expect(forced.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('不给 -o 时把结果写成"分片目录/原始文件名"，且成功后目录里只剩结果', async () => {
    const source = makeSource(5000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin', { name: '原文 报告.txt' })

    const result = await runTool(RECV, ['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(result.code).toBe(0)

    const produced = join(work, 'parts', '原文 报告.txt')
    expect(existsSync(produced)).toBe(true)
    expect(readFileSync(produced).equals(source)).toBe(true)
    expect(result.stdout).toContain(produced)
    // 分片、meta 与 resume.json 都清掉，目录本身保留（结果就在里面）
    expect(readdirSync(join(work, 'parts'))).toEqual(['原文 报告.txt'])
    expect(job.total).toBeGreaterThan(0)
  })

  it('结果同名时默认直接覆盖，--no-overwrite 才拒绝且不动已有文件', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    buildFrames('src.bin', { name: 'report.bin' })

    const first = await runTool(RECV, ['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(first.code).toBe(0)
    const produced = join(work, 'parts', 'report.bin')
    expect(readFileSync(produced).equals(source)).toBe(true)

    // 默认覆盖：把结果改坏后再收一遍应当被修回原样
    writeFileSync(produced, 'corrupted')
    const again = await runTool(RECV, ['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(again.code).toBe(0)
    expect(readFileSync(produced).equals(source)).toBe(true)

    const guarded = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'parts', '--quiet', '--no-overwrite'],
      work
    )
    expect(guarded.code).toBe(4)
    expect(readFileSync(produced).equals(source)).toBe(true)
  })

  it('缺少开始帧且没有工作目录时明确失败，不会产出半成品', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin')
    writeSubset('data-only.txt', job.lines.slice(1, 3))

    const result = await runTool(RECV, ['--in', 'data-only.txt', '-d', 'nowhere'], work)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('meta.json')
    expect(existsSync(join(work, 'nowhere'))).toBe(false)
  })
})

describe('typer-recv.mjs：真实终端噪声的容忍', () => {
  it('bracketed paste 标记、CRLF、裸 CR、噪声行混合也不影响结果', async () => {
    const source = makeSource(5000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = buildFrames('src.bin')

    // 模拟：粘贴被包在 bracketed paste 里、混入 shell 提示符/回显等噪声行、行尾混杂 CRLF 与裸 CR
    const pieces: string[] = []
    job.lines.forEach((line, index) => {
      if (index === 0) pieces.push(`\u001b[200~${line}\u001b[201~\r\n`)
      else if (index % 2 === 0) pieces.push(`${line}\r`)
      else pieces.push(`${line}\r\n`)
      if (index === 2) pieces.push('user@host:~$ echo 噪声回显\r\n')
      if (index === 5) pieces.push('\r\n')
    })
    writeFileSync(join(work, 'polluted.txt'), pieces.join(''))

    const result = await runTool(
      RECV,
      ['--in', 'polluted.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('--ack none 时不产生任何回执输出', async () => {
    const source = makeSource(2000)
    writeFileSync(join(work, 'src.bin'), source)
    buildFrames('src.bin')

    const result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--ack', 'none', '--quiet'],
      work
    )
    expect(result.stdout.trim()).toBe('')
    expect(result.code).toBe(0)
  })

  it('--cooked 与默认行为一致（同一批帧得到同一结果）', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    buildFrames('src.bin')

    const result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--cooked', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })
})

describe('应用与接收端的一致性（同一文件、同一参数）', () => {
  /**
   * @description 用应用侧模块（主进程用的那套）生成整套帧文本
   * @param path 源文件路径
   * @param options 传输选项
   * @param only 只生成这些片号（默认为全部）
   * @returns 任务句柄与帧行
   */
  async function framesFromApp(
    path: string,
    options: { encoding: 'hex' | 'b64' | 'txt'; chunkBytes: number; maxFrameChars: number },
    only?: number[]
  ): Promise<{ job: PreparedTransfer; lines: string[] }> {
    const job = await prepareTransfer({ path, options })
    const indexes = only ?? Array.from({ length: job.summary.total }, (_value, index) => index)
    const lines = [job.beginFrame()]
    for (const index of indexes) lines.push(await job.renderFrame(index))
    lines.push(job.endFrame())
    return { job, lines }
  }

  it('应用生成的帧能被接收脚本逐字节还原', async () => {
    const source = makeSource(20000)
    writeFileSync(join(work, 'src.bin'), source)

    const app = await framesFromApp(join(work, 'src.bin'), {
      encoding: 'hex',
      chunkBytes: 1024,
      maxFrameChars: 4096
    })

    writeSubset('app-frames.txt', app.lines)
    const result = await runTool(
      RECV,
      ['--in', 'app-frames.txt', '-o', 'app.out', '-d', 'app-work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'app.out')).equals(source)).toBe(true)
    await app.job.dispose()
  })

  it('txt 编码的应用帧也能逐字节还原（含中文、CRLF、空格与 emoji）', async () => {
    const text = '第一行\r\n第二行 带空格\r\n中文与 emoji 😀 结束\r\n'
    const buffer = Buffer.from(text, 'utf8')
    writeFileSync(join(work, 'note.txt'), buffer)

    const app = await framesFromApp(join(work, 'note.txt'), {
      encoding: 'txt',
      chunkBytes: 64,
      maxFrameChars: 4096
    })
    writeSubset('txt-frames.txt', app.lines)

    const result = await runTool(
      RECV,
      ['--in', 'txt-frames.txt', '-o', 'txt.out', '-d', 'txt-work', '--quiet'],
      work
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'txt.out')).equals(buffer)).toBe(true)
    await app.job.dispose()
  })

  it('用应用侧的续传比对驱动定点重传：只补缺失片即可完成', async () => {
    const source = makeSource(12000)
    writeFileSync(join(work, 'src.bin'), source)
    const app = await framesFromApp(join(work, 'src.bin'), {
      encoding: 'hex',
      chunkBytes: 1024,
      maxFrameChars: 4096
    })

    // 只发开头几片（模拟中途被打断）
    const head = app.lines.slice(0, 4)
    writeSubset('head.txt', head)
    const partial = await runTool(RECV, ['--in', 'head.txt', '-d', 'work', '--quiet'], work)
    expect(partial.code).toBe(2)

    // 读取接收端报告 → 用应用侧解析并比对
    const report = readFileSync(join(work, 'work', 'resume.json'), 'utf8')
    const matched = matchResume(parseResumeState(report), app.job.summary)
    expect(matched.missing).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11])

    // 只补缺失片（含结束帧，因为这批补完就齐了）
    const retryLines = [
      ...(await Promise.all(matched.missing.map((index) => app.job.renderFrame(index)))),
      app.job.endFrame()
    ]
    writeSubset('retry.txt', retryLines)
    const retried = await runTool(
      RECV,
      ['--in', 'retry.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(retried.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
    await app.job.dispose()
  })
})

describe('run.bat：给目标机用的双击入口', () => {
  it('内容只含 ASCII、行尾为 CRLF，并把参数与退出码原样交给 node', () => {
    const bat = readFileSync(toolPath('run.bat'), 'utf8')
    // cmd 逐字节解释 .bat：中文会随控制台代码页乱码，LF 行尾会让带标签的跳转失效
    expect(bat).not.toMatch(/[^\r\n\x20-\x7e]/)
    expect(bat).toContain('node "%~dp0typer-recv.mjs" %*')
    expect(bat).toContain('exit /b %errorlevel%')
    expect(bat).toContain('if errorlevel 1 goto :no_node')
  })

  it('真实运行 run.bat：参数与退出码原样交给 node', async () => {
    const selftest = await runBat(['--selftest'])
    expect(selftest.code).toBe(0)
    expect(selftest.stdout).toContain('自检通过')

    // --help 只打印用法、不读标准输入，适合比对"经 run.bat"与"直接跑 node"是否完全一致
    const viaBat = await runBat(['--help'])
    const direct = await runTool(RECV, ['--help'], work)
    expect(viaBat.code).toBe(direct.code)
    expect(viaBat.stdout).toBe(direct.stdout)
  })
})
