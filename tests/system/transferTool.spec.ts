import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { crc32Hex, parseFrame, sha256Hex } from '@tools/lib/frame.mjs'
import { prepareTransfer, type PreparedTransfer } from '@main/transfer/prepare'
import { matchResume, parseResumeState } from '@main/transfer/resume'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const RECV = join(root, 'tools', 'typer-recv.mjs')
const CHUNK = join(root, 'tools', 'typer-chunk.mjs')

interface ToolResult {
  code: number
  stdout: string
  stderr: string
}

/** 真实启动脚本进程：这里要验证的正是"跨进程、跨脚本"的行为，不做任何模拟。 */
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

/** 生成源文件（确定性内容，含 0x00/0xFF/CRLF 等"会捣乱"的字节）。 */
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

interface ChunkResult {
  job: string
  sha256: string
  total: number
  framesPath: string
  chunksDir: string
  lines: string[]
}

/** 用分片脚本生成帧文本（同时验证它能独立于应用工作）。 */
async function chunkFile(
  sourcePath: string,
  options: { chunk?: number; enc?: string; out?: string } = {}
): Promise<ChunkResult> {
  const args = [
    sourcePath,
    '--chunk',
    String(options.chunk ?? 1024),
    '--single',
    'frames.txt',
    '--verify'
  ]
  if (options.enc) args.push('--enc', options.enc)
  if (options.out) args.push('--out', options.out)

  const result = await runTool(CHUNK, args, work)
  expect(result.stderr, `分片脚本失败：${result.stderr}`).toBe('')
  expect(result.code).toBe(0)

  const framesPath = join(work, 'frames.txt')
  const text = readFileSync(framesPath, 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  const begin = parseFrame(lines[0] as string)
  if (begin.kind !== 'begin') throw new Error('第一行应为开始帧')

  return {
    job: begin.job,
    sha256: begin.sha256,
    total: begin.total,
    framesPath,
    chunksDir: join(work, options.out ?? `.typer-chunks-${begin.job}`),
    lines
  }
}

/** 把若干行帧文本写成文件，模拟"只发了一部分"。 */
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
    const job = await chunkFile('src.bin')

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
    await chunkFile('empty.bin')

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
    await chunkFile('src2.bin', { chunk: 333, enc: 'b64' })
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
    await chunkFile('note.txt', { chunk: 16, enc: 'txt' })
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
    const job = await chunkFile('src.bin')

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
      ['--in', 'retry.txt', '-o', 'out.bin', '-d', 'work', '--quiet', '--force'],
      work
    )
    expect(second.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('中断后续传：只发前一半 → 报告缺失片；再发剩下的（无开始帧）→ 完成且逐字节一致', async () => {
    const source = makeSource(30000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = await chunkFile('src.bin')
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
    await chunkFile('src.bin')

    const first = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin', '--keep-parts'],
      work
    )
    expect(first.code).toBe(0)

    // 保留分片：再收一遍时应当全部命中已校验通过的分片（#RESUME + 不重写）
    const second = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--keep-parts', '--force'],
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
    await chunkFile('src.bin')

    await runTool(RECV, ['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin'], work)
    const forced = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--no-resume', '--force'],
      work
    )
    expect(forced.stdout).toContain('#OK')
    expect(forced.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('缺少开始帧且没有工作目录时明确失败，不会产出半成品', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    const job = await chunkFile('src.bin')
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
    const job = await chunkFile('src.bin')

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
    await chunkFile('src.bin')

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
    await chunkFile('src.bin')

    const result = await runTool(
      RECV,
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--cooked', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })
})

describe('应用与脚本的一致性（同一文件、同一参数）', () => {
  /** 用应用侧模块（主进程用的那套）生成整套帧文本。 */
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

  it('应用生成的帧能被接收脚本逐字节还原，且与分片脚本的产物逐字段一致', async () => {
    const source = makeSource(20000)
    writeFileSync(join(work, 'src.bin'), source)

    const app = await framesFromApp(join(work, 'src.bin'), {
      encoding: 'hex',
      chunkBytes: 1024,
      maxFrameChars: 4096
    })

    // ① 与分片脚本的产物逐字段比对：两条独立实现的编码/校验路径必须完全一致
    const tool = await chunkFile('src.bin', { chunk: 1024 })
    const appFrames = app.lines.map((line) => parseFrame(line))
    const toolFrames = tool.lines.map((line) => parseFrame(line))
    expect(appFrames).toHaveLength(toolFrames.length)

    const appBegin = appFrames[0]
    const toolBegin = toolFrames[0]
    if (appBegin.kind !== 'begin' || toolBegin.kind !== 'begin') throw new Error('应为开始帧')
    expect(appBegin.total).toBe(toolBegin.total)
    expect(appBegin.size).toBe(toolBegin.size)
    expect(appBegin.chunk).toBe(toolBegin.chunk)
    expect(appBegin.sha256).toBe(toolBegin.sha256)
    expect(appBegin.name).toBe(toolBegin.name)

    for (let index = 0; index < appFrames.length; index++) {
      const left = appFrames[index]
      const right = toolFrames[index]
      expect(left.kind).toBe(right.kind)
      if (left.kind !== 'data' || right.kind !== 'data') continue
      expect(left.seq).toBe(right.seq)
      expect(left.bytes).toBe(right.bytes)
      expect(left.crc32).toBe(right.crc32)
      expect(left.sha16).toBe(right.sha16)
      expect(left.payload).toBe(right.payload)
    }

    // ② 应用产出的帧直接喂给接收脚本
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

describe('typer-chunk.mjs：分片端的独立可用性', () => {
  it('manifest.json 记录任务规模、整文件哈希与每片校验和', async () => {
    const source = makeSource(2500)
    writeFileSync(join(work, 'src.bin'), source)
    const job = await chunkFile('src.bin', { chunk: 1024 })

    const manifest = JSON.parse(readFileSync(join(job.chunksDir, 'manifest.json'), 'utf8'))
    expect(manifest.job).toBe(job.job)
    expect(manifest.size).toBe(source.length)
    expect(manifest.sha256).toBe(sha256Hex(source))
    expect(manifest.chunk).toBe(1024)
    expect(manifest.total).toBe(3)
    expect(manifest.frames).toHaveLength(3)
    expect(manifest.frames[0].bytes).toBe(1024)
    expect(manifest.frames[2].bytes).toBe(452)

    // 每片的 crc 与源文件对应区间一致
    const first = source.subarray(0, 1024)
    expect(manifest.frames[0].crc32).toBe(crc32Hex(first))
  })

  it('片大小超出帧长上限时立即失败并给出建议', async () => {
    writeFileSync(join(work, 'src.bin'), makeSource(4096))
    const result = await runTool(CHUNK, ['src.bin', '--chunk', '4096', '--single', 'f.txt'], work)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('超过上限')
    expect(result.stderr).toContain('--chunk 降到')
  })

  it('txt 编码拒绝非 UTF-8 文件（保证整文件哈希两端一致）', async () => {
    // GBK 的 "中文" = D6 D0 CE C4
    writeFileSync(join(work, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    const result = await runTool(CHUNK, ['gbk.txt', '--enc', 'txt', '--single', 'f.txt'], work)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('UTF-8')
  })

  it('--no-frames 只产出 manifest，不与 --verify 组合', async () => {
    writeFileSync(join(work, 'src.bin'), makeSource(1500))
    const result = await runTool(CHUNK, ['src.bin', '--no-frames', '--verify'], work)
    expect(result.code).toBe(4)
  })
})
