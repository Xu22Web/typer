import { describe, expect, it, vi } from 'vitest'
import { createDriver } from '@main/typing/drivers'
import { ProtocolError } from '@main/typing/drivers/protocol'
import {
  isSupportedPlatform,
  unsupportedPlatformError,
  WindowsSendInputDriver
} from '@main/typing/drivers/WindowsSendInputDriver'
import {
  createFakeClipboard,
  createFakeSpawn,
  type AutoRespondOutcome,
  type FakeChildProcess,
  type FakeSpawn
} from '../../helpers/fakes'

interface HarnessOptions {
  requestTimeoutMs?: number
  restoreClipboard?: boolean
  /** @description 覆盖某个指令的应答，例如让 type 报告注入不足或延迟响应 */
  override?: (request: Record<string, unknown>) => AutoRespondOutcome | undefined
  dryRun?: boolean
}

/**
 * @description 标准宿主应答，覆盖 ping / type / releaseAll / foreground / probe / shutdown
 * @param request 驱动发出的请求
 * @returns 对应的应答内容，未知指令返回 E_UNKNOWN_CMD
 */
function standardResponder(request: Record<string, unknown>): AutoRespondOutcome | undefined {
  switch (request.cmd) {
    case 'ping':
      return { data: { os: 'Windows 11', psVersion: '5.1', dryRun: false, inputSize: 40 } }
    case 'type': {
      const items = (request.items as Array<{ t: string; mods?: string[] }>) ?? []
      const requested = items.reduce((sum, item) => {
        if (item.t === 'key') return sum + 2 + 2 * (item.mods?.length ?? 0)
        if (item.t === 'unicode') return sum + 2
        return sum
      }, 0)
      return { data: { requested, injected: requested, items: items.length } }
    }
    case 'releaseAll':
      return { data: { released: 11 } }
    case 'foreground':
      return { data: { hwnd: 55, pid: 77, title: '目标窗口' } }
    case 'probe':
      return { data: { stuckKeys: [] } }
    case 'shutdown':
      return {}
    default:
      return { error: { code: 'E_UNKNOWN_CMD', message: String(request.cmd) } }
  }
}

/**
 * @description 组装驱动、假宿主、假剪贴板，并提供取最近子进程与全部请求的便捷方法
 * @param options 超时、剪贴板恢复、应答覆盖与 dry-run 开关
 * @returns 测试用的驱动夹具
 */
function createHarness(options: HarnessOptions = {}): {
  driver: WindowsSendInputDriver
  spawn: FakeSpawn
  clipboard: ReturnType<typeof createFakeClipboard>
  child(): FakeChildProcess
  requests(): Array<Record<string, unknown>>
} {
  const spawn = createFakeSpawn({
    autoRespond: (request) => options.override?.(request) ?? standardResponder(request)
  })
  const clipboard = createFakeClipboard('原剪贴板')
  const driver = new WindowsSendInputDriver({
    spawn: spawn.fn,
    hostScriptPath: 'C:\\app\\scripts\\typing-host.ps1',
    clipboard,
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    restoreClipboard: options.restoreClipboard ?? true,
    dryRun: options.dryRun
  })

  return {
    driver,
    spawn,
    clipboard,
    child: () => spawn.children[spawn.children.length - 1] as FakeChildProcess,
    requests: () => spawn.children.flatMap((item) => item.parsedRequests())
  }
}

describe('WindowsSendInputDriver 启动', () => {
  it('用 Windows PowerShell 5.1 启动宿主脚本并握手', async () => {
    const h = createHarness()
    await h.driver.start()

    expect(h.driver.kind).toBe('windows-sendinput')
    const call = h.spawn.calls[0]
    expect(call?.command).toBe('powershell.exe')
    expect(call?.args).toContain('-NoProfile')
    expect(call?.args).toContain('-NonInteractive')
    expect(call?.args).toContain('-ExecutionPolicy')
    expect(call?.args).toContain('Bypass')
    expect(call?.args).toContain('C:\\app\\scripts\\typing-host.ps1')
    expect(call?.options.windowsHide).toBe(true)
    expect(h.requests().some((request) => request.cmd === 'ping')).toBe(true)
  })

  it('重复 start 不会重复启动宿主', async () => {
    const h = createHarness()
    await h.driver.start()
    await h.driver.start()
    expect(h.spawn.calls).toHaveLength(1)
  })

  it('dry-run 时给宿主加 -DryRun 参数', async () => {
    const h = createHarness({ dryRun: true })
    await h.driver.start()
    expect(h.spawn.calls[0]?.args).toContain('-DryRun')
  })
})

describe('WindowsSendInputDriver 注入', () => {
  it('下发动作并校验事件数与内容', async () => {
    const h = createHarness()
    const result = await h.driver.send([
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 10 },
      { t: 'unicode', cu: 0x4e2d, delay: 10 }
    ])

    expect(result).toEqual({ requested: 6, injected: 6, items: 2 })
    const typeRequest = h.requests().find((request) => request.cmd === 'type')
    expect(typeRequest?.items).toEqual([
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 10 },
      { t: 'unicode', cu: 0x4e2d, delay: 10 }
    ])
  })

  it('空批次直接返回，不打扰宿主', async () => {
    const h = createHarness()
    expect(await h.driver.send([])).toEqual({ requested: 0, injected: 0 })
    expect(h.spawn.children).toHaveLength(0)
  })

  it('宿主报告注入不足时抛 E_INJECT_FAILED（UIPI / 安全软件）', async () => {
    const h = createHarness({
      override: (request) =>
        request.cmd === 'type' ? { data: { requested: 4, injected: 0, items: 1 } } : undefined
    })

    await expect(
      h.driver.send([{ t: 'key', vk: 0x48, mods: ['shift'], delay: 1 }])
    ).rejects.toMatchObject({ code: 'E_INJECT_FAILED' })
  })

  it('宿主返回的事件数少于预期时报错', async () => {
    const h = createHarness({
      override: (request) =>
        request.cmd === 'type' ? { data: { requested: 2, injected: 2, items: 1 } } : undefined
    })

    await expect(
      h.driver.send([{ t: 'key', vk: 0x48, mods: ['shift'], delay: 1 }])
    ).rejects.toMatchObject({ code: 'E_INJECT_FAILED' })
  })

  it('超时时间包含动作自身延迟（长批次不会被误判为超时）', async () => {
    vi.useFakeTimers()
    try {
      const h = createHarness({
        requestTimeoutMs: 50,
        override: (request) =>
          request.cmd === 'type'
            ? { data: { requested: 2, injected: 2, items: 1 }, delayMs: 200 }
            : undefined
      })

      const pending = h.driver.send([{ t: 'key', vk: 0x41, mods: [], delay: 5000 }])
      await vi.advanceTimersByTimeAsync(300)
      await expect(pending).resolves.toEqual({ requested: 2, injected: 2, items: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('releaseAll / foreground / probe 使用约定的指令名', async () => {
    const h = createHarness()
    await h.driver.start()
    await h.driver.releaseAll()
    expect(await h.driver.foreground()).toEqual({ hwnd: 55, pid: 77, title: '目标窗口' })
    expect(await h.driver.probe()).toEqual({ stuckKeys: [] })

    const commands = h.requests().map((request) => request.cmd)
    expect(commands).toContain('releaseAll')
    expect(commands).toContain('foreground')
    expect(commands).toContain('probe')
  })
})

describe('WindowsSendInputDriver 粘贴回退', () => {
  it('写剪贴板 → 发 Ctrl+V → 恢复原剪贴板', async () => {
    const h = createHarness()
    await h.driver.start()
    await h.driver.paste('中文内容')

    expect(h.clipboard.readText()).toBe('原剪贴板')
    const typeRequest = h.requests().find((request) => request.cmd === 'type')
    expect(typeRequest?.items).toEqual([{ t: 'key', vk: 0x56, mods: ['ctrl'], delay: 0 }])
  })

  it('空文本不触碰剪贴板', async () => {
    const h = createHarness()
    await h.driver.start()
    await h.driver.paste('')
    expect(h.clipboard.history).toEqual([])
  })

  it('restoreClipboard = false 时保留粘贴内容', async () => {
    const h = createHarness({ restoreClipboard: false })
    await h.driver.start()
    await h.driver.paste('留下的内容')
    expect(h.clipboard.readText()).toBe('留下的内容')
  })
})

describe('WindowsSendInputDriver 关闭', () => {
  it('dispose 通知宿主关闭并杀掉进程', async () => {
    const h = createHarness()
    await h.driver.start()
    await h.driver.dispose()
    expect(h.requests().some((request) => request.cmd === 'shutdown')).toBe(true)
    expect(h.child().killed).toBe(true)
  })
})

describe('平台支持判定与驱动工厂', () => {
  it('只有 win32 被支持', () => {
    expect(isSupportedPlatform('win32')).toBe(true)
    expect(isSupportedPlatform('darwin')).toBe(false)
    expect(isSupportedPlatform('linux')).toBe(false)
  })

  it('createDriver 在非 Windows 上抛可读错误', () => {
    try {
      createDriver({
        platform: 'darwin',
        clipboard: createFakeClipboard(),
        locator: { isPackaged: false, appPath: '/app', resourcesPath: '/res' }
      })
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe('E_UNSUPPORTED_PLATFORM')
      expect(String((error as Error).message)).toContain('仅支持 Windows')
    }
  })

  it('createDriver 在 Windows 上找不到宿主脚本时报错并列出候选路径', () => {
    expect(() =>
      createDriver({
        platform: 'win32',
        clipboard: createFakeClipboard(),
        locator: {
          isPackaged: false,
          appPath: 'C:\\app',
          resourcesPath: 'C:\\app\\resources',
          exists: () => false
        }
      })
    ).toThrow(/typing-host\.ps1/)
  })

  it('createDriver 在 Windows 上能找到脚本时返回真实驱动', () => {
    const driver = createDriver({
      platform: 'win32',
      clipboard: createFakeClipboard(),
      locator: {
        isPackaged: false,
        appPath: 'C:\\app',
        resourcesPath: 'C:\\app\\resources',
        exists: (path) => path.endsWith('typing-host.ps1')
      }
    })
    expect(driver.kind).toBe('windows-sendinput')
  })

  it('unsupportedPlatformError 带上平台名', () => {
    expect(unsupportedPlatformError('linux').message).toContain('linux')
  })
})
