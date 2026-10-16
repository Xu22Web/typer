import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseFrame } from '@main/util/frame'
import { copyToolsTo, TransferSession } from '@main/transfer/session'
import { resolveToolsDir, ToolsDirNotFoundError } from '@main/transfer/toolsLocator'
import type { TransferPrepareProgress } from '@shared/transfer/transfer'

let work: string
let sourcePath: string
let session: TransferSession

const OPTIONS = { encoding: 'hex' as const, chunkBytes: 256, maxFrameChars: 4096 }

/**
 * @description 生成确定性二进制内容
 * @param size 字节数
 * @param seed 随机种子
 * @returns 二进制内容
 */
function makeSource(size = 1024, seed = 4): Buffer {
  const buffer = Buffer.allocUnsafe(size)
  let state = seed >>> 0
  for (let index = 0; index < size; index++) {
    state = (state * 1103515245 + 12345) >>> 0
    buffer[index] = (state >>> 16) & 0xff
  }
  return buffer
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'typer-session-'))
  sourcePath = join(work, 'src.bin')
  writeFileSync(sourcePath, makeSource())
  session = new TransferSession()
  await session.prepare(sourcePath, OPTIONS)
})

afterEach(async () => {
  await session.dispose()
  rmSync(work, { recursive: true, force: true })
})

describe('TransferSession · 准备与复用', () => {
  it('准备后能给出摘要，并保留当前任务的句柄', async () => {
    const summary = session.summary
    expect(summary?.total).toBe(4)
    expect(summary?.path).toBe(sourcePath)
    expect(session.plan().indexes).toEqual([0, 1, 2, 3])
  })

  it('没有任务时任何操作都给出可读错误', () => {
    const empty = new TransferSession()
    expect(() => empty.plan()).toThrow(/还没有选择文件/)
    expect(() => empty.matchResume('0')).toThrow(/还没有选择文件/)
  })

  it('准备进度会持续回调（哈希 → 分片表）', async () => {
    const events: TransferPrepareProgress[] = []
    const tracked = new TransferSession({ onPrepareProgress: (progress) => events.push(progress) })
    await tracked.prepare(sourcePath, OPTIONS)
    await tracked.dispose()

    expect(events.some((event) => event.phase === 'hash')).toBe(true)
    expect(events.some((event) => event.phase === 'plan')).toBe(true)
  })

  it('reuse=true 时只改片大小不会重新哈希（哈希不变、片数变）', async () => {
    const before = session.summary?.sha256
    const summary = await session.prepare(
      sourcePath,
      { ...OPTIONS, chunkBytes: 128 },
      { reuse: true }
    )

    expect(summary.sha256).toBe(before)
    expect(summary.sha256).toBe(createHash('sha256').update(makeSource()).digest('hex'))
    expect(summary.total).toBe(8)
  })

  it('reuse=true 但文件已被修改时必须重新哈希（不能让校验失效）', async () => {
    const before = session.summary?.sha256
    // 写入相同长度但不同内容：只要文件被动过，就不能复用旧哈希
    writeFileSync(sourcePath, makeSource(1024, 99))

    const summary = await session.prepare(sourcePath, OPTIONS, { reuse: true })
    expect(summary.sha256).not.toBe(before)
    expect(summary.sha256).toBe(createHash('sha256').update(makeSource(1024, 99)).digest('hex'))
  })

  it('准备中的取消会中止哈希', async () => {
    const big = join(work, 'big.bin')
    writeFileSync(big, makeSource(8 * 1024 * 1024))
    const tracked = new TransferSession({
      onPrepareProgress: (progress) => {
        if (progress.phase === 'hash' && progress.done > 0) tracked.cancelPrepare()
      }
    })

    await expect(tracked.prepare(big, { ...OPTIONS, chunkBytes: 4096 })).rejects.toThrow(/取消/)
    await tracked.dispose()
  })
})

describe('TransferSession · 发送计划', () => {
  it('全新传输：全发，且开始帧与结束帧都带', () => {
    expect(session.plan()).toMatchObject({
      indexes: [0, 1, 2, 3],
      sendBegin: true,
      sendEnd: true,
      ranges: '0-3'
    })
  })

  it('只发指定片（没有续传信息）：带开始帧但不通知合并', () => {
    const plan = session.plan({ only: '1,3' })
    expect(plan.indexes).toEqual([1, 3])
    expect(plan.sendBegin).toBe(true)
    expect(plan.sendEnd).toBe(false)
    expect(plan.ranges).toBe('1,3')
  })

  it('续传补发：只补缺失片时带结束帧（接收端可以合并了）', () => {
    const plan = session.plan({ only: '1', resumeMissing: [1] })
    expect(plan.sendBegin).toBe(false)
    expect(plan.sendEnd).toBe(true)
  })

  it('续传仍未补齐：不发结束帧（否则接收端立刻报 #MISS）', () => {
    const plan = session.plan({ only: '1', resumeMissing: [1, 3] })
    expect(plan.sendEnd).toBe(false)
  })

  it('从某片开始（部分发送，不发结束帧）', () => {
    const plan = session.plan({ from: 2 })
    expect(plan.indexes).toEqual([2, 3])
    expect(plan.sendBegin).toBe(true)
    expect(plan.sendEnd).toBe(false)
  })

  it('显式覆盖优先级最高（测试与高级用法）', () => {
    expect(session.plan({ sendBegin: false, sendEnd: false })).toMatchObject({
      sendBegin: false,
      sendEnd: false
    })
  })

  it('空文件：0 片也会带开始与结束帧（接收端据此产出空文件）', async () => {
    const emptyPath = join(work, 'empty.bin')
    writeFileSync(emptyPath, Buffer.alloc(0))
    const emptySession = new TransferSession()
    await emptySession.prepare(emptyPath, OPTIONS)

    const plan = emptySession.plan()
    expect(plan.indexes).toEqual([])
    expect(plan.sendBegin).toBe(true)
    expect(plan.sendEnd).toBe(true)
    await emptySession.dispose()
  })
})

describe('TransferSession · 生成引擎任务', () => {
  it('部分补发（有续传信息）时不带开始帧也不带结束帧', () => {
    const { request, plan } = session.createRequest({ only: '0', resumeMissing: [0, 2] })
    expect(plan.indexes).toEqual([0])
    expect(request.indexes).toEqual([0])
    expect(request.total).toBe(4)
    expect(request.begin).toBeUndefined()
    expect(request.end).toBeUndefined()
  })

  it('帧渲染与字符统计一致，且渲染结果可被解析回来', async () => {
    const { request } = session.createRequest({ only: '0,2' })
    const line = await request.render(0)
    const frame = parseFrame(line)
    if (frame.kind !== 'data') throw new Error('应为数据帧')
    expect(frame.seq).toBe(0)
    expect(request.charsOf(0)).toBe(line.length)
    // 越界索引必须报错（否则会静默发错片）
    await expect(request.render(99)).rejects.toThrow(/超出范围/)
  })

  it('全量传输时请求里带上开始帧与结束帧', () => {
    const { request } = session.createRequest()
    expect(typeof request.begin).toBe('function')
    expect(typeof request.end).toBe('function')
    expect(parseFrame(request.begin?.() as string).kind).toBe('begin')
    expect(parseFrame(request.end?.() as string).kind).toBe('end')
  })
})

describe('TransferSession · 续传状态比对', () => {
  it('匹配的令牌只暴露缺失片', () => {
    const summary = session.summary as NonNullable<typeof session.summary>
    const matched = session.matchResume(`@TYPER1/R ${summary.job} ${summary.total} -`)
    expect(matched.missing).toEqual([])
    expect(matched.warnings.join()).toMatch(/收全/)
  })

  it('令牌属于别的任务时拒绝（避免两次任务混在一起）', () => {
    expect(() => session.matchResume('@TYPER1/R deadbeef 4 2-3')).toThrow(/另一次任务/)
  })

  it('匹配的报告会给出缺失片与警告', () => {
    const summary = session.summary as NonNullable<typeof session.summary>
    const matched = session.matchResume(
      JSON.stringify({
        job: summary.job,
        total: summary.total,
        size: summary.size,
        sha256: summary.sha256,
        missing: '2'
      })
    )
    expect(matched.missing).toEqual([2])
    expect(matched.warnings).toEqual([])
  })
})

describe('tools 定位与导出', () => {
  it('开发模式下以构建产物 typer-recv.mjs 为探针定位 tools 目录', () => {
    const root = join(work, 'dev')
    const dir = resolveToolsDir({
      isPackaged: false,
      appPath: root,
      resourcesPath: join(root, 'nope'),
      exists: (path) => path === join(root, 'tools', 'typer-recv.mjs')
    })
    expect(dir).toBe(join(root, 'tools'))
  })

  it('开发模式下缺构建产物时提示先运行 npm run build:tools', () => {
    expect(() =>
      resolveToolsDir({
        isPackaged: false,
        appPath: join(work, 'dev'),
        resourcesPath: join(work, 'nope'),
        exists: () => false
      })
    ).toThrow(/npm run build:tools/)
  })

  it('打包后优先在 resources 下查找；找不到时报出全部候选路径', () => {
    const dir = resolveToolsDir({
      isPackaged: true,
      appPath: join(work, 'app'),
      resourcesPath: process.cwd(),
      exists: (path) => path.startsWith(process.cwd())
    })
    expect(dir.startsWith(process.cwd())).toBe(true)

    expect(() =>
      resolveToolsDir({ isPackaged: true, appPath: work, resourcesPath: work, exists: () => false })
    ).toThrow(ToolsDirNotFoundError)
  })

  it('导出只复制构建产物与 README，不把 .ts 源码与类型声明带给用户', () => {
    const toolsDir = join(work, 'tools-src')
    mkdirSync(join(toolsDir, 'lib'), { recursive: true })
    writeFileSync(join(toolsDir, 'typer-recv.mjs'), '// 接收端构建产物\n')
    writeFileSync(join(toolsDir, 'typer-recv.ts'), 'export const dummy = 1\n')
    writeFileSync(join(toolsDir, 'typer-recv.d.mts'), 'export declare const dummy: number\n')
    writeFileSync(join(toolsDir, 'README.md'), '# 使用说明\n')
    writeFileSync(join(toolsDir, 'lib', 'frame.mjs'), '// 旧的线格式实现\n')

    const destination = join(work, 'exported')
    const copied = copyToolsTo(toolsDir, destination)

    expect(copied.sort()).toEqual(
      [join('lib', 'frame.mjs'), 'README.md', 'typer-recv.mjs'].sort() as string[]
    )
    expect(readdirSync(destination)).not.toContain('typer-recv.ts')
    expect(readdirSync(destination)).not.toContain('typer-recv.d.mts')
    expect(existsSync(join(destination, 'typer-recv.mjs'))).toBe(true)
    expect(existsSync(join(destination, 'README.md'))).toBe(true)
  })
})
