import { readFileSync } from 'node:fs'
import { describe, expect, it, afterAll } from 'vitest'
import { encodeHostItems, type HostItem } from '@main/typing/drivers/protocol'
import { HostSession } from './helpers/hostSession'
import { HOST_SCRIPT, runPowershell, TARGET_SCRIPT } from './helpers/system'

/**
 * 系统测试（无副作用，不产生任何真实按键）：覆盖脚本语法、UTF-8 BOM（Windows PowerShell
 * 5.1 靠 BOM 判定编码，否则中文乱码）、关键实现细节的静态断言，以及真实启动宿主
 * （会真的用 Add-Type 编译 C#）+ dry-run 协议往返。
 */
const PS_SCRIPTS = [HOST_SCRIPT, TARGET_SCRIPT]

/**
 * @description 以 UTF-8 读入脚本源码
 * @param path 脚本路径
 * @returns 源码文本
 */
function readSource(path: string): string {
  return readFileSync(path, 'utf8')
}

/**
 * @description 判断文件是否以 UTF-8 BOM 开头
 * @param path 文件路径
 * @returns 是否含 BOM
 */
function hasUtf8Bom(path: string): boolean {
  const bytes = readFileSync(path)
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

describe.skipIf(process.platform !== 'win32')('PowerShell 脚本静态校验', () => {
  it.each(PS_SCRIPTS)('脚本存在：%s', (path) => {
    expect(readFileSync(path).length).toBeGreaterThan(0)
  })

  it.each(PS_SCRIPTS)(
    'UTF-8 BOM 存在（否则 Windows PowerShell 5.1 会按 GBK 误读中文）：%s',
    (path) => {
      expect(hasUtf8Bom(path)).toBe(true)
    }
  )

  it.each(PS_SCRIPTS)('语法可被 PowerShell 解析器接受：%s', async (path) => {
    const result = await runPowershell([
      '-Command',
      `$errs = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 1 }`
    ])
    expect(result.stdout.trim()).toBe('')
    expect(result.code).toBe(0)
  })

  it('宿主脚本包含全部关键实现细节', () => {
    const source = readSource(HOST_SCRIPT)

    // 注入 API 与常量
    expect(source).toContain('SendInput')
    expect(source).toContain('KEYEVENTF_KEYUP = 0x0002')
    expect(source).toContain('KEYEVENTF_EXTENDEDKEY = 0x0001')
    expect(source).toContain('MapVirtualKey')

    // 远程桌面只转发真实键盘事件：脚本里不应再有 KEYEVENTF_UNICODE
    expect(source).not.toContain('KEYEVENTF_UNICODE')

    // 修饰键必须单独调用并留间隔（否则 RDP 会把同批修饰键丢掉）
    expect(source).toContain('ApplyModifierTransition')
    expect(source).toContain('HeldModMask')
    expect(source).toContain('modLeadMs')
    expect(source).toContain('modTailMs')

    // 结构体：必须与 Windows SDK 的 union 尺寸一致，否则 SendInput 返回 0
    expect(source).toContain('MOUSEINPUT')
    expect(source).toContain('KEYBDINPUT')
    expect(source).toContain('HARDWAREINPUT')
    expect(source).toContain('LayoutKind.Explicit')
    expect(source).toContain('Marshal.SizeOf')

    // 协议与命令
    for (const command of ['ping', 'type', 'releaseAll', 'foreground', 'probe', 'shutdown']) {
      expect(source).toContain(`'${command}'`)
    }
    expect(source).toContain('[switch]$DryRun')

    // 输出必须是纯 ASCII 的 JSON Lines
    expect(source).toContain('ConvertTo-AsciiJson')
  })

  it('取消只在动作组边界生效：不会留下"修饰键按下、主键未发"的中间态', () => {
    const source = readSource(HOST_SCRIPT)

    // 动作组 = 修饰键过渡 + 主键 down/up。组内的 flush 一律不理会取消，
    // 否则一旦 Shift 已经按下、主键却因取消被丢弃，目标窗口就会一直按着 Shift。
    expect(source).toContain('FlushBatch(pending, dryRun, false)')
    expect(source).toContain('FlushBatch(ups, dryRun, false)')
    expect(source).toContain('FlushBatch(downs, dryRun, false)')

    // 只有"一个事件都还没发出去"时，flush 才允许被中断（此时不会留下按下的键）
    expect(source).toContain('honorCancel && offset == 0 && StopRequested')

    // 取消点前置到动作组之前，组一开始就必须打完
    expect(source).toContain('cancelled = true')

    // 退出与启动都要清理可能残留的修饰键（上一次会话可能是被强杀的）
    expect(source).toContain('Invoke-ReleaseAll -IsDryRun $false')
  })

  it('宿主脚本用内核定时器等待而不是空转烧 CPU', () => {
    const source = readSource(HOST_SCRIPT)
    // 等待要交给内核（高分辨率可等待定时器），自旋只留一小段尾段：
    // 全程自旋会吃满一个核，整台机器都会跟着卡
    expect(source).toContain('CreateWaitableTimerExW')
    expect(source).toContain('CREATE_WAITABLE_TIMER_HIGH_RESOLUTION')
    expect(source).toContain('WaitForSingleObject')
    expect(source).toContain('SPIN_TAIL_MS')
    expect(source).toContain('timeBeginPeriod')
    expect(source).not.toContain('Thread.Sleep((int)(remainingMs - 1.0))')
  })

  it('宿主脚本带输入队列压力阀：被队列拖住时自动补等，避免整机输入被拖慢', () => {
    const source = readSource(HOST_SCRIPT)
    expect(source).toContain('VALVE_TRIGGER_MS')
    expect(source).toContain('VALVE_GAIN')
    expect(source).toContain('LastFlushTicks')
    expect(source).toContain('valveMs')
    expect(source).toContain('blockedCalls')
    // 阀要覆盖"每一次 flush"：零延迟大批次没有下一个等待可以借机降速，必须就地补等
    expect(source).toContain('ValveWaitAfterFlush')
    expect(source.match(/ValveWaitAfterFlush\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('宿主脚本在 add-type 失败时不会静默继续', () => {
    const source = readSource(HOST_SCRIPT)
    expect(source).toMatch(/Add-Type[\s\S]*catch/)
    expect(source).toContain('E_NATIVE_COMPILE')
  })
})

describe.skipIf(process.platform !== 'win32')('宿主 dry-run 真实启动', () => {
  let session: HostSession | null = null

  afterAll(() => {
    session?.dispose()
  })

  it('能编译 C# 并完成握手（inputSize 必须是 x64 的 40）', async () => {
    session = await HostSession.start({ dryRun: true })
    const ping = await session.request<{
      os: string
      psVersion: string
      dryRun: boolean
      inputSize: number
    }>('ping')

    expect(ping.dryRun).toBe(true)
    expect(ping.psVersion.startsWith('5.1')).toBe(true)
    expect(ping.inputSize).toBe(40)
    expect(session.stderr.join('')).toBe('')
  })

  it('dry-run 下按事件数回执请求的动作（含 Shift 组合符号）', async () => {
    expect(session).not.toBeNull()
    const items: HostItem[] = [
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 1 }, // H（Shift 组合）
      { t: 'key', vk: 0x31, mods: ['shift'], delay: 1 }, // !（Shift 组合，Shift 保持按住）
      { t: 'key', vk: 0x0d, mods: [], delay: 1 } // 回车（先松开 Shift）
    ]

    const result = await session!.request<{
      requested: number
      injected: number
      items: number
      blockedMs: number
      maxBlockedMs: number
      valveMs: number
      blockedCalls: number
      foreground?: { hwnd: number; pid: number; title: string }
    }>('type', encodeHostItems(items))

    // Shift 按下 1 + 三个主键 6 + Shift 抬起 1 = 8 个事件
    expect(result.requested).toBe(8)
    expect(result.injected).toBe(result.requested)
    expect(result.items).toBe(items.length)
    // dry-run 不真的调用 SendInput，因此不应报告任何"被输入队列拖住"的迹象，
    // 压力阀也不该补等（否则会白白拖慢节奏）
    expect(result.blockedMs).toBe(0)
    expect(result.maxBlockedMs).toBe(0)
    expect(result.valveMs).toBe(0)
    expect(result.blockedCalls).toBe(0)
    // 焦点守护靠这条"搭车"信息，省掉每批一次单独的 foreground 往返
    expect(result.foreground).toBeDefined()
    expect(typeof result.foreground?.pid).toBe('number')
  })

  it('releaseAll / probe / foreground 都能正常响应', async () => {
    expect(session).not.toBeNull()
    const released = await session!.request<{ released: number }>('releaseAll')
    expect(released.released).toBeGreaterThan(0)

    const probe = await session!.request<{ stuckKeys: number[] }>('probe')
    // dry-run 不产生真实按键，因此不应报任何粘键（不是“是数组就行”）
    expect(probe.stuckKeys).toEqual([])

    const foreground = await session!.request<{ hwnd: number; pid: number; title: string }>(
      'foreground'
    )
    expect(typeof foreground.pid).toBe('number')
    expect(typeof foreground.title).toBe('string')
  })

  it('未知指令返回可读错误而不是崩溃', async () => {
    expect(session).not.toBeNull()
    await expect(session!.request('这不存在')).rejects.toThrow(/E_UNKNOWN_CMD|未知指令/)
    // 出错后仍然可用
    const ping = await session!.request<{ dryRun: boolean }>('ping')
    expect(ping.dryRun).toBe(true)
  })

  it('畸形指令不会让宿主退出', async () => {
    expect(session).not.toBeNull()
    // 真的注入一行坏 JSON：宿主应记错并继续服务，而不是退出
    session!.writeRaw('{bad json')
    await new Promise((resolve) => setTimeout(resolve, 150))
    const healthy = await session!.request<{ inputSize: number }>('ping')
    expect(healthy.inputSize).toBe(40)
  })
})
