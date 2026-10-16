import { describe, expect, it } from 'vitest'
import {
  FocusGuard,
  evaluateFocus,
  sameWindow,
  type FocusSnapshot
} from '@main/typing/focus/focusGuard'
import { MockKeyboardDriver } from '@main/typing/drivers/MockKeyboardDriver'

const target: FocusSnapshot = { hwnd: 100, pid: 10, title: '记事本' }
const other: FocusSnapshot = { hwnd: 200, pid: 20, title: '浏览器' }

describe('sameWindow', () => {
  it('hwnd 相同即同一个窗口', () => {
    expect(sameWindow(target, { ...target, title: '改过标题' })).toBe(true)
  })

  it('hwnd 不同但 pid + 标题相同也算同一个（句柄可能被复用/重建）', () => {
    expect(sameWindow(target, { hwnd: 999, pid: 10, title: '记事本' })).toBe(true)
  })

  it('窗口确实变了则不同', () => {
    expect(sameWindow(target, other)).toBe(false)
  })
})

describe('evaluateFocus', () => {
  it('off 模式从不阻止、也不告警', () => {
    expect(evaluateFocus('off', target, other)).toEqual({ blocked: false, changed: false })
  })

  it('未记录过目标窗口时不判定', () => {
    expect(evaluateFocus('warn', null, other)).toEqual({ blocked: false, changed: false })
  })

  it('窗口未变化时不告警', () => {
    expect(evaluateFocus('strict', target, target)).toEqual({ blocked: false, changed: false })
  })

  it('warn 模式：变化 → 告警但不阻止', () => {
    const verdict = evaluateFocus('warn', target, other)
    expect(verdict.changed).toBe(true)
    expect(verdict.blocked).toBe(false)
    expect(verdict.warning).toContain('记事本')
    expect(verdict.warning).toContain('浏览器')
  })

  it('strict 模式：变化 → 直接阻止（附带说明）', () => {
    const verdict = evaluateFocus('strict', target, other)
    expect(verdict.blocked).toBe(true)
    expect(verdict.warning).toBeTruthy()
  })
})

describe('FocusGuard', () => {
  it('off 模式完全不查询驱动', async () => {
    const driver = new MockKeyboardDriver()
    const guard = new FocusGuard('off', driver)
    let calls = 0
    driver.foreground = async () => {
      calls += 1
      return target
    }
    expect(await guard.capture()).toBeNull()
    expect((await guard.verify(null)).blocked).toBe(false)
    expect(calls).toBe(0)
  })

  it('capture 记录目标窗口，verify 检测变化', async () => {
    const driver = new MockKeyboardDriver({ foreground: target })
    const guard = new FocusGuard('strict', driver)
    const captured = await guard.capture()
    expect(captured).toEqual(target)

    driver.foreground = async () => other
    const verdict = await guard.verify(captured)
    expect(verdict.blocked).toBe(true)
  })

  it('查询前台窗口失败时不阻止输入（宽松降级）', async () => {
    const driver = new MockKeyboardDriver()
    const guard = new FocusGuard('strict', driver)
    driver.foreground = async () => {
      throw new Error('宿主挂了')
    }
    expect(await guard.capture()).toBeNull()
    expect((await guard.verify(target)).blocked).toBe(false)
  })
})
