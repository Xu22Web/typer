import { describe, expect, it } from 'vitest'
import { MockKeyboardDriver } from '@main/typing/drivers/MockKeyboardDriver'
import { LAYOUTS } from '@main/typing/planner/keymap'
import { TypingEngine, type EngineSettings } from '@main/typing/engine/TypingEngine'
import type { ProgressSnapshot } from '@main/typing/engine/progress'
import type { EngineSnapshot, EngineState } from '@main/typing/engine/states'
import type { HostItem } from '@main/typing/drivers/protocol'
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

/**
 * @description 构造引擎设置，未指定的字段取默认值
 * @param overrides 需要覆盖的设置项
 * @returns 完整的引擎设置
 */
function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return {
    startDelayMs: 0,
    insertMode: 'keystroke',
    autoPasteThreshold: 100_000,
    chunkSize: 8,
    layout: 'us',
    forceUnicodeForAll: false,
    focusGuard: 'off',
    seed: 42,
    verifyStuckKeys: false,
    timing,
    typo: { rate: 0, style: 'adjacent', correction: 'auto' },
    ...overrides
  }
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
 * @description 组装引擎夹具：可注入驱动与虚拟时钟，并记录状态、进度与日志
 * @param options 需要注入的驱动或时钟
 * @returns 测试用的引擎夹具
 */
function createHarness(
  options: {
    driver?: MockKeyboardDriver
    clock?: VirtualClock
  } = {}
): Harness {
  const driver = options.driver ?? new MockKeyboardDriver()
  const clock = options.clock ?? createVirtualClock()
  const states: EngineState[] = []
  const progress: ProgressSnapshot[] = []
  const logs: string[] = []

  const engine = new TypingEngine({
    driver,
    sleep: clock.sleep,
    now: clock.now,
    onState: (snapshot: EngineSnapshot) => states.push(snapshot.state),
    onProgress: (snapshot) => progress.push(snapshot),
    onLog: (_level, message) => logs.push(message),
    progressIntervalMs: 0
  })

  return { engine, driver, clock, states, progress, logs }
}

/**
 * @description 由键位表建立 "vk+修饰键" → 字符 的反查表
 * @returns 用于还原按键输出的映射
 */
function buildUsReverseMap(): Map<string, string> {
  const map = new Map<string, string>()
  for (const [char, key] of Object.entries(LAYOUTS.us.charMap)) {
    const signature = `${key.vk}+${[...key.modifiers].sort().join(',')}`
    map.set(signature, char)
  }
  return map
}

const US_REVERSE = buildUsReverseMap()

/**
 * @description 把下发事件还原成目标窗口里出现的文本，并应用退格，校验净效果
 * @param items 引擎下发的宿主指令
 * @returns 还原后的文本
 */
function applyBackspaces(items: HostItem[]): string {
  let output = ''
  for (const item of items) {
    if (item.t === 'wait') continue
    if (item.t === 'unicode') {
      output += String.fromCharCode(item.cu)
      continue
    }
    const signature = `${item.vk}+${[...item.mods].sort().join(',')}`
    if (item.vk === 0x08 && item.mods.length === 0) {
      output = Array.from(output).slice(0, -1).join('')
      continue
    }
    output += US_REVERSE.get(signature) ?? `[vk:${item.vk}]`
  }
  return output
}

describe('TypingEngine 正常流程', () => {
  it('按顺序下发全部动作，并在结束时释放修饰键', async () => {
    const h = createHarness()
    const result = await h.engine.start('Hi中', engineSettings())

    expect(result.state).toBe('completed')
    expect(h.driver.releaseAllCalls).toBe(1)
    expect(h.driver.pasted).toEqual([])

    const chars = h.driver.items.map((item) => {
      if (item.t === 'unicode') return item.cu
      if (item.t === 'key') return item.vk
      return -1
    })
    expect(chars).toEqual([0x48, 0x49, 0x4e2d])
    expect(h.driver.items[0]).toEqual({ t: 'key', vk: 0x48, mods: ['shift'], delay: 10 })
    expect(h.driver.items[2]).toEqual({ t: 'unicode', cu: 0x4e2d, delay: 10 })
  })

  it('空文本立即完成，且不启动宿主', async () => {
    const h = createHarness()
    const result = await h.engine.start('', engineSettings())
    expect(result.state).toBe('completed')
    expect(result.total).toBe(0)
    expect(h.driver.started).toHaveLength(0)
    expect(h.driver.batches).toHaveLength(0)
  })

  it('按 chunkSize 分批下发', async () => {
    const h = createHarness()
    await h.engine.start('abcdefghij', engineSettings({ chunkSize: 4 }))
    expect(h.driver.batches.map((batch) => batch.length)).toEqual([4, 4, 2])
  })

  it('大文本不会被一次性构建（分批次数与 chunkSize 一致）', async () => {
    const h = createHarness()
    const text = 'a'.repeat(1000)
    const result = await h.engine.start(text, engineSettings({ chunkSize: 8 }))
    expect(result.total).toBe(1000)
    expect(h.driver.batches).toHaveLength(Math.ceil(1000 / 8))
  })

  it('状态迁移：countdown → running → completed', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ startDelayMs: 500 }))
    expect(h.states[0]).toBe('countdown')
    expect(h.states).toContain('running')
    expect(h.states[h.states.length - 1]).toBe('completed')
  })

  it('开始后重复 start 会被拒绝（不会出现两条输入流）', async () => {
    const h = createHarness()
    const pending = h.engine.start(
      'a'.repeat(50),
      engineSettings({ chunkSize: 1, startDelayMs: 0 })
    )
    await expect(h.engine.start('b', engineSettings())).rejects.toThrow('已有输入任务')
    h.engine.abort('测试结束')
    await pending
  })
})

describe('TypingEngine 中止与暂停', () => {
  it('倒计时期间中止：不下发任何动作，但会释放修饰键', async () => {
    const clock = createVirtualClock({
      beforeResolve: () => {
        h.engine.abort('倒计时取消')
      }
    })
    const h = createHarness({ clock })
    const result = await h.engine.start('abc', engineSettings({ startDelayMs: 5000 }))

    expect(result.state).toBe('aborted')
    expect(h.driver.batches).toHaveLength(0)
    expect(h.driver.started).toHaveLength(0)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('输入中途中止：在 chunk 边界停止，state 为 aborted', async () => {
    let sent = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        sent += 1
        if (sent === 2) engineHarness.engine.abort('用户紧急停止')
      }
    })
    const engineHarness = createHarness({ driver })

    const result = await engineHarness.engine.start(
      'a'.repeat(40),
      engineSettings({ chunkSize: 4 })
    )
    expect(result.state).toBe('aborted')
    // 第 2 批结束后立即中止，因此只会有 2 批
    expect(driver.batches).toHaveLength(2)
    expect(driver.releaseAllCalls).toBe(1)
  })

  it('暂停 → 继续：动作不丢失也不重复', async () => {
    let batches = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        batches += 1
        if (batches === 1) {
          h.engine.pause()
          queueMicrotask(() => h.engine.resume())
        }
      }
    })
    const h = createHarness({ driver })
    const result = await h.engine.start('abcdefgh', engineSettings({ chunkSize: 2 }))

    expect(result.state).toBe('completed')
    expect(h.driver.items).toHaveLength(8)
    expect(h.states).toContain('paused')
    expect(result.typed).toBe(8)
  })

  it('暂停状态下中止：唤醒等待并结束为 aborted', async () => {
    let batches = 0
    const driver = new MockKeyboardDriver({
      onSend: () => {
        batches += 1
        if (batches === 1) h.engine.pause()
      }
    })
    const h = createHarness({ driver })
    const pending = h.engine.start('abcdefgh', engineSettings({ chunkSize: 2 }))
    // 等引擎进入 paused（driver.send 之后会走到 chunk 边界）
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.engine.abort('暂停中停止')
    const result = await pending
    expect(result.state).toBe('aborted')
    expect(h.driver.releaseAllCalls).toBe(1)
  })
})

describe('TypingEngine 错误处理', () => {
  it('驱动报错时状态为 failed，并且仍然释放修饰键', async () => {
    const driver = new MockKeyboardDriver({ failing: true })
    const h = createHarness({ driver })
    const result = await h.engine.start('abc', engineSettings())

    expect(result.state).toBe('failed')
    expect(result.error).toBeInstanceOf(Error)
    expect(h.driver.releaseAllCalls).toBe(1)
    expect(h.logs.some((line) => line.includes('输入失败'))).toBe(true)
  })

  it('完成后自检粘键（verifyStuckKeys）', async () => {
    const driver = new MockKeyboardDriver()
    const h = createHarness({ driver })
    await h.engine.start('abc', engineSettings({ verifyStuckKeys: true }))
    expect(h.logs.some((line) => line.includes('按下状态'))).toBe(false)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('跳过不可输入字符时会记日志', async () => {
    const h = createHarness()
    await h.engine.start('a\u0000b', engineSettings())
    expect(h.logs.some((line) => line.includes('已跳过不可输入字符'))).toBe(true)
  })
})

describe('TypingEngine 进度', () => {
  it('进度单调不减，最终 typed === total', async () => {
    const h = createHarness()
    const result = await h.engine.start('a'.repeat(20), engineSettings({ chunkSize: 3 }))

    expect(result.typed).toBe(result.total)
    expect(result.total).toBe(20)

    const percents = h.progress.map((snapshot) => snapshot.percent)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
    }
    expect(percents[percents.length - 1]).toBe(1)
  })

  it('倒计时阶段会上报剩余毫秒', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ startDelayMs: 250 }))
    const countdown = h.progress.filter((snapshot) => snapshot.stage === 'countdown')
    expect(countdown.length).toBeGreaterThan(0)
    expect(countdown[0]!.countdownRemainingMs).toBeGreaterThan(0)
  })

  it('总动作数与带错字的计划一致（计数与产出使用同种子）', async () => {
    const h = createHarness()
    const result = await h.engine.start(
      'hello world',
      engineSettings({ chunkSize: 3, typo: { rate: 0.5, style: 'adjacent', correction: 'auto' } })
    )
    expect(result.typed).toBe(result.total)
    expect(h.driver.items).toHaveLength(result.total)
    expect(applyBackspaces(h.driver.items)).toBe('hello world')
  })
})

describe('TypingEngine 粘贴模式', () => {
  it('paste 模式整段粘贴，不逐字下发', async () => {
    const h = createHarness()
    const result = await h.engine.start('中文内容', engineSettings({ insertMode: 'paste' }))
    expect(result.state).toBe('completed')
    expect(h.driver.pasted).toEqual(['中文内容'])
    expect(h.driver.batches).toHaveLength(0)
    expect(result.typed).toBe(result.total)
  })

  it('auto 模式超过阈值时自动改用粘贴', async () => {
    const h = createHarness()
    await h.engine.start(
      'a'.repeat(30),
      engineSettings({ insertMode: 'auto', autoPasteThreshold: 10 })
    )
    expect(h.driver.pasted).toHaveLength(1)
  })

  it('auto 模式未超过阈值时仍逐字输入', async () => {
    const h = createHarness()
    await h.engine.start('abc', engineSettings({ insertMode: 'auto', autoPasteThreshold: 10 }))
    expect(h.driver.pasted).toHaveLength(0)
    expect(h.driver.items.length).toBeGreaterThan(0)
  })
})

describe('TypingEngine 焦点守护', () => {
  it('strict 模式：前台窗口变化时中止', async () => {
    const driver = new MockKeyboardDriver({
      foreground: { hwnd: 1, pid: 100, title: '目标窗口' },
      foregroundQueue: [{ hwnd: 2, pid: 200, title: '别的窗口' }]
    })
    const h = createHarness({ driver })
    const result = await h.engine.start(
      'a'.repeat(20),
      engineSettings({ chunkSize: 4, focusGuard: 'strict' })
    )

    expect(result.state).toBe('aborted')
    expect(h.driver.batches).toHaveLength(0)
    expect(h.driver.releaseAllCalls).toBe(1)
  })

  it('warn 模式：窗口变化时只提示，仍然完成输入', async () => {
    const driver = new MockKeyboardDriver({
      foreground: { hwnd: 1, pid: 100, title: '目标窗口' },
      foregroundQueue: [{ hwnd: 2, pid: 200, title: '别的窗口' }]
    })
    const h = createHarness({ driver })
    const result = await h.engine.start(
      'abcd',
      engineSettings({ chunkSize: 2, focusGuard: 'warn' })
    )

    expect(result.state).toBe('completed')
    expect(h.driver.items).toHaveLength(4)
    expect(h.logs.some((line) => line.includes('前台窗口已变化'))).toBe(true)
  })

  it('off 模式：完全不查询前台窗口', async () => {
    const driver = new MockKeyboardDriver()
    const h = createHarness({ driver })
    let calls = 0
    const original = driver.foreground.bind(driver)
    driver.foreground = async () => {
      calls += 1
      return original()
    }
    await h.engine.start('abc', engineSettings({ focusGuard: 'off' }))
    expect(calls).toBe(0)
  })
})
