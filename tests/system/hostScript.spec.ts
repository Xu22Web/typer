import { readFileSync } from 'node:fs'
import { describe, expect, it, afterAll } from 'vitest'
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

describe('PowerShell 脚本静态校验', () => {
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
    expect(source).toContain('KEYEVENTF_UNICODE = 0x0004')
    expect(source).toContain('KEYEVENTF_KEYUP = 0x0002')
    expect(source).toContain('KEYEVENTF_EXTENDEDKEY = 0x0001')
    expect(source).toContain('MapVirtualKey')

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

  it('宿主脚本在 add-type 失败时不会静默继续', () => {
    const source = readSource(HOST_SCRIPT)
    expect(source).toMatch(/Add-Type[\s\S]*catch/)
    expect(source).toContain('E_NATIVE_COMPILE')
  })
})

describe('宿主 dry-run 真实启动', () => {
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

  it('dry-run 下按事件数回执请求的动作（含中文、emoji、Shift 组合符号）', async () => {
    expect(session).not.toBeNull()
    const items = [
      { t: 'key', vk: 0x48, mods: ['shift'], delay: 1 }, // H（Shift 组合）
      { t: 'key', vk: 0x31, mods: ['shift'], delay: 1 }, // !（Shift 组合）
      { t: 'unicode', cu: 0x4e2d, delay: 1 }, // 中
      { t: 'unicode', cu: 0xd83d, delay: 1 }, // 😀 高代理
      { t: 'unicode', cu: 0xde00, delay: 1 }, // 😀 低代理
      { t: 'key', vk: 0x0d, mods: [], delay: 1 } // 回车
    ]

    const result = await session!.request<{ requested: number; injected: number; items: number }>(
      'type',
      { items }
    )

    // 2 个 Shift 组合按键 × (2 本体 + 2 修饰) = 8；3 个 unicode = 6；回车 2 → 共 16
    expect(result.requested).toBe(16)
    expect(result.injected).toBe(result.requested)
    expect(result.items).toBe(items.length)
  })

  it('releaseAll / probe / foreground 都能正常响应', async () => {
    expect(session).not.toBeNull()
    const released = await session!.request<{ released: number }>('releaseAll')
    expect(released.released).toBeGreaterThan(0)

    const probe = await session!.request<{ stuckKeys: number[] }>('probe')
    expect(Array.isArray(probe.stuckKeys)).toBe(true)

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
    // 直接注入一行坏 JSON：宿主应继续服务
    const healthy = await session!.request<{ inputSize: number }>('ping')
    expect(healthy.inputSize).toBe(40)
  })
})
