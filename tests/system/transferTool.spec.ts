import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFrame, sha256Hex } from '@main/util/frame'
import { prepareTransfer, type PreparedTransfer } from '@main/transfer/prepare'
import { matchResume, parseResumeState } from '@main/transfer/resume'
import type { TransferPrepareOptions } from '@shared/transfer/transfer'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/**
 * @description 定位接收端构建产物；产物由 `pnpm build:tools`（源码 tools/typer-recv.ts）打包生成，
 * 缺失时必须明确报错——静默跳过会让"接收端坏了"看起来像"测试通过"
 * @param name 产物文件名
 * @returns 产物绝对路径
 */
function toolPath(name: string): string {
  const path = join(root, 'tools', name)
  if (!existsSync(path)) {
    throw new Error(
      `缺少接收端构建产物 ${path}：请先运行 pnpm build:tools（由 tools/typer-recv.ts 打包生成）`
    )
  }
  return path
}

const RECV = toolPath('typer-recv.mjs')

interface ToolResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * @description 真实启动脚本进程并收集输出；这里要验证的正是"跨进程、跨脚本"的行为，不做任何模拟
 * @param args 脚本参数
 * @param cwd 工作目录
 * @returns 退出码与 stdout/stderr
 */
async function runTool(args: string[], cwd: string): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [RECV, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * @description 通过 cmd 运行 tools/run.bat：验证"目标机双击这个文件"真的能启动接收端。
 * 用 spawn 显式把 stdin 设成 ignore —— 接收端在没给 `--in` 时会一直等标准输入，测试里必须立刻给它 EOF
 * @param args 传给 run.bat 的参数
 * @returns 退出码与 stdout/stderr
 */
function runBat(args: string[], cwd: string): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', toolPath('run.bat'), ...args],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
    child.on('error', () => resolvePromise({ code: -1, stdout, stderr }))
  })
}

let work: string

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'typer-tool-'))
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

/**
 * @description 生成确定性源文件，含 0x00 / 0xFF / 行尾 / Ctrl+Z 等"会捣乱"的字节
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
  buffer.write('\r\n\u001a', 0, 'latin1')
  return buffer
}

const DEFAULT_OPTIONS: TransferPrepareOptions = {
  alphabet: 'ascii32',
  compression: 'none',
  quality: 9,
  mode: 'term',
  chunkBytes: 1024,
  maxFrameChars: 65536
}

interface FrameSet {
  job: PreparedTransfer
  lines: string[]
}

/**
 * @description 用应用侧的实现生成整套帧（与 Typer 真正发送时完全同源）
 * @param sourcePath 相对于 work 的源文件路径
 * @param overrides 覆盖传输选项
 * @param only 只生成这些片号（默认全部）
 * @returns 任务句柄与帧行
 */
async function appFrames(
  sourcePath: string,
  overrides: Partial<TransferPrepareOptions> = {},
  only?: number[]
): Promise<FrameSet> {
  const job = await prepareTransfer({
    path: join(work, sourcePath),
    options: { ...DEFAULT_OPTIONS, ...overrides }
  })
  const indexes = only ?? Array.from({ length: job.summary.total }, (_value, index) => index)
  const lines = [job.beginFrame()]
  for (const index of indexes) lines.push(await job.renderFrame(index))
  lines.push(job.endFrame())
  return { job, lines }
}

/**
 * @description 把若干行帧文本写成文件
 * @param name 文件名
 * @param lines 帧行
 * @param eol 行尾（默认 LF；也可以传空串模拟单行输入框）
 * @returns 文件路径
 */
function writeFrames(name: string, lines: string[], eol = '\n'): string {
  const path = join(work, name)
  writeFileSync(path, lines.length === 0 ? '' : `${lines.join(eol)}${eol}`)
  return path
}

describe('typer-recv.mjs：端到端接收与完整性校验', () => {
  it('--selftest 通过（目标机环境自检）', async () => {
    const result = await runTool(['--selftest'], work)
    expect(result.stdout).toContain('自检通过')
    expect(result.code).toBe(0)
  })

  it('进度回显：--progress on 报规模与片数百分比，--in 默认不刷', async () => {
    const source = makeSource(70_000)
    writeFileSync(join(work, 'src.bin'), source)
    const all = await appFrames('src.bin')
    writeFrames('frames.txt', all.lines)

    const shown = await runTool(
      ['--in', 'frames.txt', '-o', 'prog.bin', '-d', 'parts-prog', '--progress', 'on'],
      work
    )
    expect(shown.stderr).toBe('')
    expect(shown.code).toBe(0)
    // 规模一行 + 至少一行"接收 x/y 片 · p%"
    expect(shown.stdout).toContain('接收开始')
    expect(shown.stdout).toMatch(/接收 \d+\/\d+ 片 · \d+\.\d%/)

    // --in 是离线校验：默认 auto 模式下只打一行规模摘要，不刷进度行
    const silent = await runTool(['--in', 'frames.txt', '-o', 'auto.bin', '-d', 'parts-auto'], work)
    expect(silent.code).toBe(0)
    expect(silent.stdout).toContain('接收开始')
    expect(silent.stdout).not.toMatch(/\/s · 剩余/)
    // --quiet 时即使显式 --progress on 也不刷
    const quietOn = await runTool(
      ['--in', 'frames.txt', '-o', 'quiet.bin', '-d', 'parts-quiet', '--quiet', '--progress', 'on'],
      work
    )
    expect(quietOn.code).toBe(0)
    expect(quietOn.stdout).not.toContain('接收开始')
  }, 60_000)

  it('--progress 只接受 auto / on / off', async () => {
    const result = await runTool(['--progress', 'loud'], work)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('--progress 只接受')
  })

  it('默认 ascii32（5 位、零 Shift）档的二进制文件逐字节还原，退出码 0', async () => {
    const source = makeSource(70_000)
    writeFileSync(join(work, 'src.bin'), source)
    const all = await appFrames('src.bin')
    writeFrames('frames.txt', all.lines)

    const result = await runTool(
      ['--in', 'frames.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('#DONE')
    expect(result.code).toBe(0)
    expect(sha256Hex(readFileSync(join(work, 'out.bin')))).toBe(all.job.summary.sha256)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  }, 60_000)

  it('空文件也能完成（0 片，产出空文件）', async () => {
    writeFileSync(join(work, 'empty.bin'), Buffer.alloc(0))
    const { lines } = await appFrames('empty.bin')
    writeFrames('frames.txt', lines)

    const result = await runTool(
      ['--in', 'frames.txt', '-o', 'empty.out', '-d', 'work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'empty.out')).length).toBe(0)
  })

  it.each(['ascii32', 'ascii64', 'hex'] as const)('%s 档都能逐字节还原', async (alphabet) => {
    const source = makeSource(9000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin', { alphabet })
    writeFrames('frames.txt', lines)

    const result = await runTool(
      ['--in', 'frames.txt', '-o', 'out.bin', '-d', `work-${alphabet}`, '--quiet'],
      work
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('整文件压缩（br）下也能逐字节还原，且线上字节显著更少', async () => {
    const source = Buffer.from(
      '压缩传输自检：文件、代码与 JSON 都能被压到很小。\n'.repeat(300),
      'utf8'
    )
    writeFileSync(join(work, 'zip-src.txt'), source)
    const { job, lines } = await appFrames('zip-src.txt', { compression: 'br' })
    writeFrames('frames.txt', lines)

    const result = await runTool(
      ['--in', 'frames.txt', '-o', 'gz.out', '-d', 'gz-work', '--quiet'],
      work
    )
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'gz.out')).equals(source)).toBe(true)
    expect(job.summary.compression).toBe('br')
    expect(job.summary.wireBytes).toBeLessThan(source.length / 2)
  })
})

describe('typer-recv.mjs：坏数据与断点续传', () => {
  it('篡改一帧 → 只有该片失败，退出码 2 并给出缺失片号；补传该片后完成', async () => {
    const source = makeSource(20_000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')

    // 破坏第 5 片载荷里的一个字符（长度不变，只是内容变了）
    const broken = [...lines]
    const target = broken[6] as string
    const marker = target.lastIndexOf(' ') + 1
    const mutated = target[marker] === 'A' ? 'B' : 'A'
    broken[6] = `${target.slice(0, marker)}${mutated}${target.slice(marker + 1)}`
    writeFrames('broken.txt', broken)

    const first = await runTool(
      ['--in', 'broken.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(first.stdout).toContain('#FAIL 5')
    expect(first.stdout).toContain('#MISS 5')
    expect(first.code).toBe(2)

    const tokenLine = first.stdout.split('\n').find((line) => line.startsWith('@T2R'))
    expect(tokenLine).toBeTruthy()
    const token = parseFrame(tokenLine as string)
    if (token.kind !== 'resume') throw new Error('应为续传令')
    expect(token.missing).toEqual([5])

    // 只补这一片 + 结束帧：接收端从工作目录恢复任务信息
    writeFrames('retry.txt', [lines[6] as string, lines.at(-1) as string])
    const second = await runTool(
      ['--in', 'retry.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(second.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  }, 60_000)

  it('中断后续传：只发前一半 → 报告缺失片；再发剩下的（无开始帧）→ 完成且逐字节一致', async () => {
    const source = makeSource(30_000)
    writeFileSync(join(work, 'src.bin'), source)
    const { job, lines } = await appFrames('src.bin')
    const half = Math.floor(job.summary.total / 2)

    writeFrames('part1.txt', lines.slice(0, half + 1))
    const first = await runTool(['--in', 'part1.txt', '-d', 'work', '--quiet'], work)
    expect(first.code).toBe(2)
    expect(first.stdout).toContain('#MISS')

    const report = JSON.parse(readFileSync(join(work, 'work', 'resume.json'), 'utf8'))
    expect(report.job).toBe(job.summary.job)
    expect(report.done).toBe(half)
    expect(report.missing).toBe(`${half}-${job.summary.total - 1}`)
    expect(report.sha256).toBe(job.summary.sha256)

    writeFrames('part2.txt', lines.slice(half + 1))
    const second = await runTool(
      ['--in', 'part2.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('#DONE')
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  }, 60_000)

  it('幂等：重复收同一批帧不会破坏结果（已通过的分片会被跳过）', async () => {
    const source = makeSource(8000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')
    writeFrames('frames.txt', lines)

    const first = await runTool(
      ['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin', '--keep-parts', '--quiet'],
      work
    )
    expect(first.code).toBe(0)

    const second = await runTool(
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--keep-parts', '--quiet'],
      work
    )
    expect(second.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('--no-resume 时忽略已有分片并全部重收', async () => {
    const source = makeSource(4000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')
    writeFrames('frames.txt', lines)

    await runTool(['--in', 'frames.txt', '-d', 'work', '-o', 'first.bin', '--quiet'], work)
    const forced = await runTool(
      ['--in', 'frames.txt', '-d', 'work', '-o', 'out.bin', '--no-resume', '--quiet'],
      work
    )
    expect(forced.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('不给 -o 时把结果写成"分片目录/原始文件名"，且成功后目录里只剩结果', async () => {
    const source = makeSource(5000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines, job } = await appFrames('src.bin', { name: '原文 报告.txt' })
    writeFrames('frames.txt', lines)

    const result = await runTool(['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(result.code).toBe(0)

    const produced = join(work, 'parts', '原文 报告.txt')
    expect(existsSync(produced)).toBe(true)
    expect(readFileSync(produced).equals(source)).toBe(true)
    expect(result.stdout).toContain('#DONE')
    expect(readdirSync(join(work, 'parts'))).toEqual(['原文 报告.txt'])
    expect(job.summary.total).toBeGreaterThan(0)
  })

  it('结果同名时默认直接覆盖，--no-overwrite 才拒绝且不动已有文件', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin', { name: 'report.bin' })
    writeFrames('frames.txt', lines)

    const first = await runTool(['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(first.code).toBe(0)
    const produced = join(work, 'parts', 'report.bin')
    expect(readFileSync(produced).equals(source)).toBe(true)

    writeFileSync(produced, 'corrupted')
    const again = await runTool(['--in', 'frames.txt', '-d', 'parts', '--quiet'], work)
    expect(again.code).toBe(0)
    expect(readFileSync(produced).equals(source)).toBe(true)

    writeFileSync(produced, 'keep-me')
    const guarded = await runTool(
      ['--in', 'frames.txt', '-d', 'parts', '--quiet', '--no-overwrite'],
      work
    )
    expect(guarded.code).toBe(4)
    expect(readFileSync(produced, 'utf8')).toBe('keep-me')
  })

  it('缺少开始帧且没有工作目录时明确失败，不会产出半成品', async () => {
    const source = makeSource(3000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')
    writeFrames('data-only.txt', lines.slice(1, 3))

    const result = await runTool(['--in', 'data-only.txt', '-d', 'nowhere', '--quiet'], work)
    expect(result.code).toBe(4)
    expect(result.stdout).toContain('job')
    expect(result.stdout).toContain('#FAIL 0')
    expect(existsSync(join(work, 'nowhere'))).toBe(false)
  })
})

describe('typer-recv.mjs：真实链路噪声的容忍', () => {
  it('bracketed paste 标记、CRLF、裸 CR、噪声行混合也不影响结果', async () => {
    const source = makeSource(5000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')

    const pieces: string[] = []
    lines.forEach((line, index) => {
      if (index === 0) pieces.push(`\u001b[200~${line}\u001b[201~\r\n`)
      else if (index % 2 === 0) pieces.push(`${line}\r`)
      else pieces.push(`${line}\r\n`)
      if (index === 2) pieces.push('user@host:~$ echo 噪声回显\r\n')
      if (index === 5) pieces.push('\r\n')
    })
    writeFileSync(join(work, 'polluted.txt'), pieces.join(''))

    const result = await runTool(
      ['--in', 'polluted.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('单行输入框（完全没有换行）：靠 @T2 标记切分也能完整还原', async () => {
    const source = makeSource(6000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin', { mode: 'line' })
    writeFrames('line.txt', lines, '')

    const result = await runTool(
      ['--in', 'line.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  })

  it('--probe 只统计收到了什么，不落盘', async () => {
    const source = makeSource(6000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')
    writeFrames('frames.txt', lines)

    const result = await runTool(['--in', 'frames.txt', '--probe', '--quiet'], work)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('#PROBE')
    expect(result.stdout).toContain('alpha=ascii32')
    // 不写分片目录、不写输出文件
    expect(readdirSync(work).filter((name) => name.startsWith('.typer-'))).toEqual([])
  })

  it('--stats 打印字符数与吞吐（用来自查链路速度）', async () => {
    const source = makeSource(4000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin')
    writeFrames('frames.txt', lines)

    const result = await runTool(
      ['--in', 'frames.txt', '-o', 'out.bin', '-d', 'work', '--stats', '--quiet'],
      work
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/#STATS chunks=\d+ bytes=4000 wire=4000 chars=\d+ ms=\d+ cps=\d+/)
  })
})

describe('应用与接收端的一致性（同一文件、同一参数）', () => {
  it('用应用侧的续传比对驱动定点重传：只补缺失片即可完成', async () => {
    const source = makeSource(12_000)
    writeFileSync(join(work, 'src.bin'), source)
    const all = await appFrames('src.bin')
    const total = all.job.summary.total

    // 只发开头几片（模拟中途被打断）
    writeFrames('head.txt', all.lines.slice(0, 4))
    const partial = await runTool(['--in', 'head.txt', '-d', 'work', '--quiet'], work)
    expect(partial.code).toBe(2)

    const report = readFileSync(join(work, 'work', 'resume.json'), 'utf8')
    const matched = matchResume(parseResumeState(report), all.job.summary)
    const expected = Array.from({ length: total - 3 }, (_value, index) => index + 3)
    expect(matched.missing).toEqual(expected)

    const retryLines = [
      ...(await Promise.all(matched.missing.map((index) => all.job.renderFrame(index)))),
      all.job.endFrame()
    ]
    writeFrames('retry.txt', retryLines)
    const retried = await runTool(
      ['--in', 'retry.txt', '-o', 'out.bin', '-d', 'work', '--quiet'],
      work
    )
    expect(retried.code).toBe(0)
    expect(readFileSync(join(work, 'out.bin')).equals(source)).toBe(true)
  }, 60_000)

  it('帧文本里只有 ASCII 帧头与符号表字符，没有任何空白分片', async () => {
    const source = makeSource(4000)
    writeFileSync(join(work, 'src.bin'), source)
    const { lines } = await appFrames('src.bin', { alphabet: 'ascii64' })

    for (const line of lines) {
      const parts = line.split(' ')
      expect(parts.length).toBeGreaterThanOrEqual(4)
      // 载荷（最后一段）里不允许出现空白
      expect(parts.at(-1)).not.toMatch(/\s/)
      expect(line).not.toMatch(/[\r\n]/)
      expect(basename('src.bin')).toBeTruthy()
    }
  })
})

describe.skipIf(process.platform !== 'win32')('run.bat：给目标机用的双击入口', () => {
  it('内容只含 ASCII、行尾为 CRLF，并把参数与退出码原样交给 node', () => {
    const bat = readFileSync(toolPath('run.bat'), 'utf8')
    // cmd 逐字节解释 .bat：中文会随控制台代码页乱码，LF 行尾会让带标签的跳转失效
    expect(bat).not.toMatch(/[^\r\n\x20-\x7e]/)
    expect(bat).toContain('node "%~dp0typer-recv.mjs" %*')
    expect(bat).toContain('exit /b %errorlevel%')
    expect(bat).toContain('if errorlevel 1 goto :no_node')
  })

  it('真实运行 run.bat：参数与退出码原样交给 node', async () => {
    const selftest = await runBat(['--selftest'], work)
    expect(selftest.code).toBe(0)
    expect(selftest.stdout).toContain('自检通过')

    const help = await runBat(['--help'], work)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('Typer 文件接收端 v2')
  })
})
