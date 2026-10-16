import { describe, expect, it } from 'vitest'
import { disposeHotkeys, registerHotkeys, type HotkeyRegistrar } from '@main/typing/hotkeys'

interface Harness {
  registrar: HotkeyRegistrar
  registered: Map<string, () => void>
  unregisterAllCalls: number
  occupied: Set<string>
  failNext: boolean
}

function createRegistrar(): Harness {
  const harness: Harness = {
    registered: new Map(),
    unregisterAllCalls: 0,
    occupied: new Set(),
    failNext: false,
    registrar: {
      register: (accelerator, callback) => {
        if (harness.failNext) {
          harness.failNext = false
          throw new Error('注册失败')
        }
        if (harness.occupied.has(accelerator)) return false
        harness.registered.set(accelerator, callback)
        return true
      },
      unregisterAll: () => {
        harness.unregisterAllCalls += 1
        harness.registered.clear()
      }
    }
  }
  return harness
}

describe('registerHotkeys', () => {
  it('注册停止与暂停热键，并把回调接到处理器', () => {
    const h = createRegistrar()
    const events: string[] = []
    const report = registerHotkeys(
      h.registrar,
      { stop: 'Ctrl+Alt+X', togglePause: 'Ctrl+Alt+P' },
      {
        stop: () => events.push('stop'),
        togglePause: () => events.push('toggle')
      }
    )

    expect(report.registered).toEqual(['Ctrl+Alt+X', 'Ctrl+Alt+P'])
    expect(report.failed).toEqual([])

    h.registered.get('Ctrl+Alt+X')?.()
    h.registered.get('Ctrl+Alt+P')?.()
    expect(events).toEqual(['stop', 'toggle'])
  })

  it('热键被占用时记录失败原因，不影响另一个热键', () => {
    const h = createRegistrar()
    h.occupied.add('Ctrl+Alt+X')
    const report = registerHotkeys(
      h.registrar,
      { stop: 'Ctrl+Alt+X', togglePause: 'Ctrl+Alt+P' },
      { stop: () => {}, togglePause: () => {} }
    )

    expect(report.registered).toEqual(['Ctrl+Alt+P'])
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.accelerator).toBe('Ctrl+Alt+X')
    expect(report.failed[0]?.reason).toContain('占用')
  })

  it('两个热键相同时只注册一次，另一个记为重复', () => {
    const h = createRegistrar()
    const report = registerHotkeys(
      h.registrar,
      { stop: 'Ctrl+Alt+X', togglePause: 'Ctrl+Alt+X' },
      { stop: () => {}, togglePause: () => {} }
    )
    expect(report.registered).toEqual(['Ctrl+Alt+X'])
    expect(report.failed[0]?.reason).toContain('重复')
  })

  it('未配置（空字符串）时给出提示', () => {
    const h = createRegistrar()
    const report = registerHotkeys(
      h.registrar,
      { stop: '   ', togglePause: '' },
      { stop: () => {}, togglePause: () => {} }
    )
    expect(report.registered).toEqual([])
    expect(report.failed).toHaveLength(2)
    expect(report.failed[0]?.reason).toContain('未配置')
  })

  it('registrar.register 抛错时不会中断流程', () => {
    const h = createRegistrar()
    h.failNext = true
    const report = registerHotkeys(
      h.registrar,
      { stop: 'Ctrl+Alt+X', togglePause: 'Ctrl+Alt+P' },
      { stop: () => {}, togglePause: () => {} }
    )
    // 第一个热键注册失败，第二个不受影响
    expect(report.registered).toEqual(['Ctrl+Alt+P'])
    expect(report.failed).toHaveLength(1)
  })

  it('热键字符串前后空格会被裁剪', () => {
    const h = createRegistrar()
    const report = registerHotkeys(
      h.registrar,
      { stop: '  Ctrl+Alt+X  ', togglePause: '' },
      { stop: () => {}, togglePause: () => {} }
    )
    expect(report.registered).toEqual(['Ctrl+Alt+X'])
  })
})

describe('disposeHotkeys', () => {
  it('调用 unregisterAll 清理全部热键', () => {
    const h = createRegistrar()
    registerHotkeys(
      h.registrar,
      { stop: 'Ctrl+Alt+X', togglePause: 'Ctrl+Alt+P' },
      { stop: () => {}, togglePause: () => {} }
    )
    disposeHotkeys(h.registrar)
    expect(h.unregisterAllCalls).toBe(1)
    expect(h.registered.size).toBe(0)
  })

  it('unregisterAll 抛错时静默处理（退出流程不能崩）', () => {
    const registrar: HotkeyRegistrar = {
      register: () => true,
      unregisterAll: () => {
        throw new Error('已退出')
      }
    }
    expect(() => disposeHotkeys(registrar)).not.toThrow()
  })
})
