import { describe, expect, it } from 'vitest'
import { MockKeyboardDriver } from '@main/typing/drivers/MockKeyboardDriver'
import { LAYOUTS } from '@main/typing/planner/keymap'
import {
  TypingEngine,
  type EngineSettings,
  type TypingRequest
} from '@main/typing/engine/TypingEngine'
import type { HostItem } from '@main/typing/drivers/protocol'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineState } from '@main/typing/engine/states'
import type { TimingSettings } from '@main/typing/scheduling/timing'
import { buildBeginFrame, buildDataFrame, buildEndFrame } from '@main/util/frame'
import { createVirtualClock, type VirtualClock } from '../../helpers/virtualClock'

const timing: TimingSettings = {
  speedMode: 'interval',
  cps: 10,
  wpm: 120,
  baseIntervalMs: 10,
  jitterMs: 0,
  distribution: 'uniform',
  wordPauseMs: 0,
  punctuationPauseMs: 0,
  newlinePauseMs: 0,
  paragraphPauseMs: 0,
  burstSize: 0,
  burstPauseMs: 0
}

/**
 * @description 构造引擎设置，未指定的字段取默认值
 * @param overrides 需要覆盖的设置项
 * @returns 完整的引擎设置
 */
function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    startDelayMs: 0,
    chunkSize: 8,
    layout: 'us',
    focusGuard: 'off',
    seed: 42,
    verifyStuckKeys: false,
    interFrameDelayMs: 0,
    timing,
    typo: { rate: 0, style: 'adjacent', correction: 'auto' },
    ...overrides
  }
}

/** @description 反向字符表：把 "vk+修饰键" 还原成字符，用于断言目标窗口里出现的文本 */
const US_REVERSE = new Map<string, string>(
  Object.entries(LAYOUTS.us.charMap).map(([char, key]) => [
    `${key.vk}+${[...key.modifiers].sort().join(',')}`,
    char
  ])
)

/** @description 把宿主指令还原成目标窗口里出现的文本，用于断言。CR 与回车都算行尾（接收端两者都认） */
function itemsToText(items: HostItem[]): string {
  let out = ''
  for (const item of items) {
    if (item.t === 'key') {
      if (item.vk === 13) out += '\n'
      else if (item.vk === 9) out += '\t'
      else out += US_REVERSE.get(`${item.vk}+${[...item.mods].sort().join(',')}`) ?? `<${item.vk}>`
    }
  }
  return out
}

interface Harness {
  engine: TypingEngine
  driver: MockKeyboardDriver
  clock: VirtualClock
  states: EngineState[]
  progress: ProgressSnapshot[]
  logs: string[]
}

/**
 * @description 组装引擎夹具：假驱动 + 虚拟时钟，并记录状态、进度与日志
 * @returns 测试用的引擎夹具
 */
function createHarness(): Harness {
  const driver = new MockKeyboardDriver()
  const clock = createVirtualClock()
  const states: EngineState[] = []
  const progress: ProgressSnapshot[] = []
  const logs: string[] = []
  const engine = new TypingEngine({
    driver,
    sleep: clock.sleep,
    now: clock.now,
    onState: (snapshot) => states.push(snapshot.state),
    onProgress: (snapshot) => progress.push(snapshot),
    onLog: (_level, message) => logs.push(message),
    progressIntervalMs: 0
  })
  return { engine, driver, clock, states, progress, logs }
}

/**
 * 三片数据帧：用真实的 v2 帧构造器生成，避免 fixture 与线格式（@T2D/@T2H/@T2E）漂移。
 * 引擎不解析帧内容，这里只关心“逐字符下发与顺序”。
 */
const JOB = 'abc12345'
const DIGEST = '0'.repeat(64)
const FRAMES = [
  buildDataFrame({ job: JOB, seq: 0, bytes: 4, crc32: '00000000', payload: 'abcd' }),
  buildDataFrame({ job: JOB, seq: 1, bytes: 4, crc32: '00000000', payload: 'cdef' }),
  buildDataFrame({ job: JOB, seq: 2, bytes: 2, crc32: '00000000', payload: 'ef' })
]
const BEGIN = buildBeginFrame({
  job: JOB,
  total: 3,
  size: 10,
  wire: 10,
  chunk: 4,
  name: 'demo',
  alphabet: 'ascii32',
  compression: 'none',
  mode: 'term',
  sha256: DIGEST
})
const END = buildEndFrame({ job: JOB, total: 3, size: 10, wire: 10, sha256: DIGEST })

/**
 * @description 构造一个三片式文件传输任务
 * @param overrides 需要覆盖的任务字段，如只发部分片或去掉首尾帧
 * @returns 帧模式的任务描述
 */
function frameJob(
  overrides: Partial<Extract<TypingRequest, { kind: 'frames' }>> = {}
): Extract<TypingRequest, { kind: 'frames' }> {
  return {
    kind: 'frames',
    jobId: 'abc12345',
    total: 3,
    indexes: [0, 1, 2],
    render: (index: number) => FRAMES[index] as string,
    charsOf: (index: number) => (FRAMES[index] as string).length,
    begin: () => BEGIN,
    end: () => END,
    ...overrides
  }
}

/**
 * @description 统计按行发送时实际要"打"出去的字符数（每行含行尾换行）
 * @param lines 待发送的文本行
 * @returns 总字符数
 */
function chars(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

describe('引擎 · 文件传输模式', () => {
  it('逐帧发送：开始帧 → 各数据帧 → 结束帧，每帧的字符完整且顺序正确', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(frameJob(), engineSettings())

    expect(result.state).toBe('completed')
    expect(itemsToText(driver.items)).toBe(
      [...Array(3).fill(BEGIN), ...FRAMES, ...Array(3).fill(END)]
        .map((line) => `${line}\n`)
        .join('')
    )
    // 每批都有界：数据帧必须逐动作小批投递（一次投递太多会在目标端队列排满时丢字符）
    expect(Math.max(...driver.batches.map((batch) => batch.length))).toBeLessThanOrEqual(64)
  })

  it('每帧都完整下发且以 Enter 结尾（不会被切成半行）', async () => {
    const { engine, driver } = createHarness()
    await engine.start(frameJob(), engineSettings())

    expect(itemsToText(driver.items)).toBe(
      [...Array(3).fill(BEGIN), ...FRAMES, ...Array(3).fill(END)]
        .map((line) => `${line}\n`)
        .join('')
    )
  })

  it('帧内间隔攒批下发：一整帧只产生少量断批点，且总间隔与逐字符一致', async () => {
    const { engine, driver } = createHarness()
    // 一帧 1000 个字符：逐字符下发会有 1000 次 SendInput（宿主见到 delay 就断批），
    // 攒批后每 16ms 才断一次（帧内间隔为 MIN_DELAY_MS = 1ms → 每 16 个字符一次）
    const longFrame = 'a'.repeat(1000)
    await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length,
        begin: undefined,
        end: undefined
      }),
      engineSettings()
    )

    const delays = driver.items.map((item) => (item.t === 'wait' ? item.ms : item.delay))
    const breaks = delays.filter((ms) => ms > 0)
    expect(driver.items).toHaveLength(longFrame.length + 1)
    // 1001 个字符 → 每 16 个一批 → 63 个断批点
    expect(breaks).toHaveLength(Math.ceil((longFrame.length + 1) / 16))
    // 总间隔必须与逐字符一致（攒批只是把等待提前，不能改变总时长）
    expect(breaks.reduce((sum, ms) => sum + ms, 0)).toBe(longFrame.length + 1)
    // 每个断批点都必须是该批的第一个动作
    expect(delays.slice(0, 4)).toEqual([16, 0, 0, 0])
  })

  it('极速节奏：帧内仍逐字符留间隔（数据不能丢），只是不等片间停顿', async () => {
    const { engine, driver } = createHarness()
    const longFrame = 'a'.repeat(600)
    const result = await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length,
        begin: undefined,
        end: undefined
      }),
      engineSettings({ transferPace: 'fast', interFrameDelayMs: 120 })
    )

    expect(result.state).toBe('completed')
    // 帧内每个字符 1ms（这是"不丢字符"的下限），攒批窗口为 16ms；极速档省下的是片间断顿
    const delays = driver.items.map((item) => (item.t === 'wait' ? item.ms : item.delay))
    expect(delays.filter((ms) => ms > 0).every((ms) => ms <= 16)).toBe(true)
    // 攒批不改变总时长：所有等待加起来正好等于字符数 × 1ms
    expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(longFrame.length + 1)
    // 601 个字符（含行尾）→ 每 128 个一批
    const sizes = driver.batches.map((batch) => batch.length)
    expect(sizes.slice(0, -1).every((size) => size === 128)).toBe(true)
    expect(sizes.at(-1)).toBe(89)
    expect(itemsToText(driver.items)).toBe(`${longFrame}\n`)
  })

  it('帧模式绝不打错字：即使错字概率拉满，文本仍逐字符原样', async () => {
    const { engine, driver } = createHarness()
    await engine.start(
      frameJob(),
      engineSettings({
        typo: { rate: 1, style: 'adjacent', correction: 'auto' }
      })
    )

    expect(itemsToText(driver.items)).toContain(`${FRAMES[0] as string}\n`)
    // 出现退格就说明插入了错字纠正，那会直接破坏数据
    expect(driver.items.some((item) => item.t === 'key' && item.vk === 8)).toBe(false)
  })

  it('片间停顿按设置生效', async () => {
    const { engine, clock } = createHarness()
    await engine.start(frameJob(), engineSettings({ interFrameDelayMs: 25 }))

    // 3 片 → 2 次片间停顿；开始帧与结束帧不计入
    expect(clock.sleeps.filter((ms) => ms === 25)).toHaveLength(2)
  })

  it('稳健/快速档逐动作投递：每批不超过 128 个动作，且都带 perItem', async () => {
    const { engine, driver } = createHarness()
    const longFrame = buildDataFrame({
      job: 'abc12345',
      seq: 0,
      bytes: 200,
      crc32: '00000000',
      payload: 'abcd'.repeat(60)
    })

    await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length
      }),
      engineSettings({ transferPace: 'fast' })
    )

    expect(driver.batches.length).toBeGreaterThan(1)
    expect(driver.sendOptions.every((options) => options.perItem === true)).toBe(true)
    expect(Math.max(...driver.batches.map((batch) => batch.length))).toBeLessThanOrEqual(128)
  })

  it('极速档：逐动作投递、零延迟，速度交给压力阀', async () => {
    const { engine, driver } = createHarness()
    const longFrame = 'a'.repeat(1200)

    const result = await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length,
        begin: undefined,
        end: undefined
      }),
      engineSettings({ transferPace: 'turbo', interFrameDelayMs: 25 })
    )

    expect(result.state).toBe('completed')
    // 零延迟：不许出现 plan 出来的正延迟
    const delays = driver.items.map((item) => (item.t === 'wait' ? item.ms : item.delay))
    expect(delays.every((ms) => ms === 0)).toBe(true)
    // 数据帧必须逐动作投递：攒批直投实测会静默丢字符（真实 cmd 接收端一次丢几十到几百个）
    expect(driver.sendOptions.every((options) => options.perItem === true)).toBe(true)
    // 每批上限 256 个动作：1201 个字符 → 5 批
    const sizes = driver.batches.map((batch) => batch.length)
    expect(sizes).toEqual([256, 256, 256, 256, 177])
    expect(itemsToText(driver.items)).toBe(`${longFrame}\n`)
  })

  it('极速节奏档忽略片间停顿：连设置的 25ms 也不再等待', async () => {
    const { engine, clock } = createHarness()
    await engine.start(frameJob(), engineSettings({ transferPace: 'fast', interFrameDelayMs: 25 }))

    expect(clock.sleeps.filter((ms) => ms >= 25)).toHaveLength(0)
  })

  it('节奏设置对帧模式完全没有影响：极端设置与全 0 的指令序列、总耗时一致', async () => {
    const neutral = createHarness()
    await neutral.engine.start(frameJob(), engineSettings())

    // 抖动 / 突发停顿 / 标点 / 换行 / 段落停顿全部拉到极端，错字概率拉满
    const extreme: TimingSettings = {
      speedMode: 'interval',
      cps: 1,
      wpm: 1,
      baseIntervalMs: 500,
      jitterMs: 5000,
      distribution: 'uniform',
      wordPauseMs: 9999,
      punctuationPauseMs: 9999,
      newlinePauseMs: 9999,
      paragraphPauseMs: 9999,
      burstSize: 2,
      burstPauseMs: 20000
    }
    const noisy = createHarness()
    await noisy.engine.start(
      frameJob(),
      engineSettings({
        timing: extreme,
        typo: { rate: 1, style: 'adjacent', correction: 'auto' }
      })
    )

    // 帧模式使用确定性节奏：每条宿主指令（含其 delay）都必须与"全 0"逐字节相同
    expect(noisy.driver.items).toEqual(neutral.driver.items)
    // 帧内容耗时 = 所有指令 delay 之和，两轮必须一致且非 0（排除"假一致"）
    const sumDelay = (items: HostItem[]): number =>
      items.reduce((sum, item) => sum + (item.t === 'wait' ? item.ms : item.delay), 0)
    expect(sumDelay(noisy.driver.items)).toBe(sumDelay(neutral.driver.items))
    expect(sumDelay(neutral.driver.items)).toBeGreaterThan(0)
  })

  it('片间断顿仍按 interFrameDelayMs 生效：总时长 = 帧内容 + 2×片间断顿', async () => {
    const zero = createHarness()
    await zero.engine.start(frameJob(), engineSettings({ interFrameDelayMs: 0 }))

    const spaced = createHarness()
    await spaced.engine.start(frameJob(), engineSettings({ interFrameDelayMs: 25 }))

    // 3 片 → 2 次片间停顿；帧内容耗时确定性不变，差值正好是 2×片间断顿
    expect(spaced.clock.sleeps.filter((ms) => ms === 25)).toHaveLength(2)
    expect(spaced.clock.now() - zero.clock.now()).toBe(2 * 25)
  })

  it('只发指定片时严格只发这些片，且不发结束帧', async () => {
    const { engine, driver } = createHarness()
    const seen: number[] = []
    const result = await engine.start(
      frameJob({ indexes: [1], end: undefined, onFrame: (index) => seen.push(index) }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    expect(seen).toEqual([1])
    expect(itemsToText(driver.items)).toBe(
      `${[BEGIN, BEGIN, BEGIN].join('\n')}\n${FRAMES[1] as string}\n`
    )
  })

  it('渲染某片失败：记录日志与失败计数，其余片继续发送', async () => {
    const { engine, logs, progress } = createHarness()
    const failed: Array<{ index: number; ok: boolean; error?: string }> = []
    const result = await engine.start(
      frameJob({
        render: (index: number) => {
          if (index === 1) throw new Error('读取分片失败')
          return `frame-${index}`
        },
        charsOf: () => 8,
        onFrame: (index, ok, error) => failed.push({ index, ok, error })
      }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    expect(failed).toEqual([
      { index: 0, ok: true, error: undefined },
      { index: 1, ok: false, error: '读取分片失败' },
      { index: 2, ok: true, error: undefined }
    ])
    expect(logs.some((line) => line.includes('第 1 片发送失败'))).toBe(true)
    const last = progress.at(-1)
    expect(last?.frames?.failed).toBe(1)
    expect(last?.frames?.done).toBe(2)
  })

  it('进度按"片"维度上报（总数 = 本次计划片数）', async () => {
    const { engine, progress } = createHarness()
    await engine.start(frameJob(), engineSettings({ interFrameDelayMs: 5 }))

    const frames = progress.map((snapshot) => snapshot.frames).filter(Boolean)
    expect(frames[0]).toMatchObject({ done: 0, total: 3, lastIndex: -1, failed: 0 })
    expect(frames.at(-1)).toMatchObject({ done: 3, total: 3, lastIndex: 2, failed: 0 })
    // 字符维度总量 = 9 帧文本 + 9 个行尾（开始/结束帧各发 3 遍）
    expect(progress.at(-1)?.total).toBe(chars([BEGIN, BEGIN, BEGIN, ...FRAMES, END, END, END]))
  })

  it('帧正文与换行都走真实按键（远程桌面只转发键盘事件）', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(frameJob(), engineSettings())

    expect(result.state).toBe('completed')
    expect(driver.items.some((item) => item.t === 'key')).toBe(true)
    // 换行用真回车：9 行 → 9 个回车键
    expect(driver.items.filter((item) => item.t === 'key' && item.vk === 13).length).toBe(9)
    expect(itemsToText(driver.items)).toBe(
      [...Array(3).fill(BEGIN), ...FRAMES, ...Array(3).fill(END)]
        .map((line) => `${line}\n`)
        .join('')
    )
  })

  it('超长帧按 128 个动作一批下发：每批有界，顺序与文本不变', async () => {
    const { engine, driver } = createHarness()
    // 700 个字符的一帧（真实场景里一帧可达数千字符，整帧塞进一次请求会让停止等上几十秒）
    const longFrame = 'a'.repeat(700)
    const result = await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length,
        begin: undefined,
        end: undefined
      }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    // 701 个字符 → 5 批 128 + 1 批 61
    const sizes = driver.batches.map((batch) => batch.length)
    // 默认稳健档每批 64 个动作；701 = 10×64 + 61
    expect(sizes.slice(0, 10).every((size) => size === 64)).toBe(true)
    expect(sizes.at(-1)).toBe(61)
    expect(itemsToText(driver.items)).toBe(`${longFrame}\n`)
  })

  it('超长帧发送过程中中止：下一批就停，不必等整帧打完', async () => {
    const clock = createVirtualClock()
    const holder: { engine?: TypingEngine } = {}
    const driver = new MockKeyboardDriver({
      onSend: (_items, index) => {
        if (index === 1) holder.engine?.abort('测试中止')
      }
    })
    const engine = new TypingEngine({ driver, sleep: clock.sleep, now: clock.now })
    holder.engine = engine

    const longFrame = 'a'.repeat(700)
    const result = await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        render: () => longFrame,
        charsOf: () => longFrame.length,
        begin: undefined,
        end: undefined
      }),
      engineSettings()
    )

    expect(result.state).toBe('aborted')
    // 停在第 2 批（256 + 256 个动作），第三批不再下发
    expect(driver.batches).toHaveLength(2)
  })

  it('中止：片间中止后立即结束，并释放修饰键', async () => {
    const { engine, driver, states } = createHarness()
    let sent = 0
    const result = await engine.start(
      frameJob({
        onFrame: () => {
          sent += 1
          if (sent === 1) engine.abort('测试中止')
        }
      }),
      engineSettings()
    )

    expect(result.state).toBe('aborted')
    expect(states).toContain('aborted')
    expect(driver.releaseAllCalls).toBeGreaterThan(0)
    expect(itemsToText(driver.items)).not.toContain('CCDD')
  })

  it('暂停与继续：暂停期间不再发送新的片，继续后完成', async () => {
    const { engine, driver } = createHarness()
    let sent = 0
    const promise = engine.start(
      frameJob({
        onFrame: () => {
          sent += 1
          if (sent === 2) engine.pause()
        }
      }),
      engineSettings()
    )

    // 等引擎真正进入暂停等待（否则 resume 会先于 pause 执行，测试就失去意义）
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(engine.state).toBe('paused')
    const batchesWhilePaused = driver.batches.length
    // 暂停后不再产生新的下发
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(driver.batches).toHaveLength(batchesWhilePaused)

    engine.resume()
    const result = await promise

    expect(result.state).toBe('completed')
    // 继续后把剩下的片发完（真实内容校验见"每帧都完整下发"用例）
    expect(itemsToText(driver.items)).toBe(
      [...Array(3).fill(BEGIN), ...FRAMES, ...Array(3).fill(END)]
        .map((line) => `${line}\n`)
        .join('')
    )
  })

  it('空任务（没有要发的片）也能干净结束', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(
      frameJob({ indexes: [], begin: undefined, end: undefined }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    expect(driver.items).toEqual([])
    expect(driver.releaseAllCalls).toBeGreaterThan(0)
  })

  it('文本任务路径不受影响：字符串入参仍按文本处理', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start('hello ab', engineSettings())

    expect(result.state).toBe('completed')
    expect(itemsToText(driver.items)).toBe('hello ab')
  })
})
