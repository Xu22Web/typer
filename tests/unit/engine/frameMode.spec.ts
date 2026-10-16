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

function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    startDelayMs: 0,
    insertMode: 'paste',
    autoPasteThreshold: 100_000,
    chunkSize: 8,
    layout: 'us',
    forceUnicodeForAll: false,
    focusGuard: 'off',
    seed: 42,
    verifyStuckKeys: false,
    interFrameDelayMs: 0,
    pasteFrameIncludesNewline: true,
    timing,
    typo: { rate: 0, style: 'adjacent', correction: 'auto' },
    ...overrides
  }
}

/** 把下发的动作还原成"目标窗口里出现的文本"（用于按键模式断言）。 */
const US_REVERSE = new Map<string, string>(
  Object.entries(LAYOUTS.us.charMap).map(([char, key]) => [
    `${key.vk}+${[...key.modifiers].sort().join(',')}`,
    char
  ])
)

function itemsToText(items: HostItem[]): string {
  let out = ''
  for (const item of items) {
    if (item.t === 'unicode') out += String.fromCharCode(item.cu)
    else if (item.t === 'key') {
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

/** 构造一个"3 片"的任务：帧文本刻意包含数字、大写与 + / =（hex 与 b64 的典型字符）。 */
const FRAMES = [
  '@TYPER1/D abc 0 3 4 0000 0000 hex AABB',
  '@TYPER1/D abc 1 3 4 0000 0000 hex CCDD',
  '@TYPER1/D abc 2 3 2 0000 0000 hex EE'
]
const BEGIN = '@TYPER1/B abc12345 3 10 hex 4 demo 00'
const END = '@TYPER1/E abc12345 3 10 00'

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

/** 单行文本 + 行尾换行 = 需要"打"出去的字符数。 */
function chars(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0)
}

describe('引擎 · 文件传输模式', () => {
  it('逐帧发送：开始帧 → 各数据帧 → 结束帧，每帧独占一次下发', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(frameJob(), engineSettings())

    expect(result.state).toBe('completed')
    expect(driver.pasted).toEqual([BEGIN, ...FRAMES, END].map((line) => `${line}\n`))
  })

  it('按键模式下每帧都完整下发且以 Enter 结尾（不会被切成半行）', async () => {
    const { engine, driver } = createHarness()
    await engine.start(
      frameJob(),
      engineSettings({ insertMode: 'keystroke', autoPasteThreshold: 1 })
    )

    expect(itemsToText(driver.items)).toBe(
      [BEGIN, ...FRAMES, END].map((line) => `${line}\n`).join('')
    )
    expect(driver.pasted).toEqual([])
  })

  it('帧模式绝不打错字：即使错字概率拉满，文本仍逐字符原样', async () => {
    const { engine, driver } = createHarness()
    await engine.start(
      frameJob(),
      engineSettings({
        insertMode: 'keystroke',
        autoPasteThreshold: 1,
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

  it('只发指定片时严格只发这些片，且不发结束帧', async () => {
    const { engine, driver } = createHarness()
    const seen: number[] = []
    const result = await engine.start(
      frameJob({ indexes: [1], end: undefined, onFrame: (index) => seen.push(index) }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    expect(seen).toEqual([1])
    expect(driver.pasted).toEqual([`${BEGIN}\n`, `${FRAMES[1] as string}\n`])
  })

  it('上限阈值附近的帧自动选择粘贴 / 按键', async () => {
    const single = { total: 1, indexes: [0], begin: undefined, end: undefined }

    const byKeys = createHarness()
    await byKeys.engine.start(
      frameJob({ ...single, render: () => 'X', charsOf: () => 1 }),
      engineSettings({ insertMode: 'auto', autoPasteThreshold: 10 })
    )
    expect(byKeys.driver.pasted).toEqual([])
    expect(itemsToText(byKeys.driver.items)).toBe('X\n')

    const byPaste = createHarness()
    await byPaste.engine.start(
      frameJob({ ...single, render: () => 'Y'.repeat(50), charsOf: () => 50 }),
      engineSettings({ insertMode: 'auto', autoPasteThreshold: 10 })
    )
    expect(byPaste.driver.pasted).toEqual([`${'Y'.repeat(50)}\n`])
  })

  it('粘贴不含换行时，额外补一个 Enter 动作', async () => {
    const { engine, driver } = createHarness()
    await engine.start(
      frameJob({
        total: 1,
        indexes: [0],
        begin: undefined,
        end: undefined,
        render: () => 'Z',
        charsOf: () => 1
      }),
      engineSettings({ pasteFrameIncludesNewline: false })
    )

    expect(driver.pasted).toEqual(['Z'])
    expect(driver.items.some((item) => item.t === 'key' && item.vk === 13)).toBe(true)
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
    // 字符维度总量 = 5 帧文本 + 5 个行尾
    expect(progress.at(-1)?.total).toBe(chars([BEGIN, ...FRAMES, END]))
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
      engineSettings({ insertMode: 'keystroke', autoPasteThreshold: 1 })
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
    expect(driver.pasted).toHaveLength(3) // 开始帧 + 前 2 片

    engine.resume()
    const result = await promise

    expect(result.state).toBe('completed')
    expect(driver.pasted).toHaveLength(5)
  })

  it('空任务（没有要发的片）也能干净结束', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(
      frameJob({ indexes: [], begin: undefined, end: undefined }),
      engineSettings()
    )

    expect(result.state).toBe('completed')
    expect(driver.pasted).toEqual([])
    expect(driver.releaseAllCalls).toBeGreaterThan(0)
  })

  it('文本任务路径不受影响：字符串入参仍按文本处理', async () => {
    const { engine, driver } = createHarness()
    const result = await engine.start(
      '中文ab',
      engineSettings({ insertMode: 'keystroke', autoPasteThreshold: 1 })
    )

    expect(result.state).toBe('completed')
    expect(itemsToText(driver.items)).toBe('中文ab')
  })
})
