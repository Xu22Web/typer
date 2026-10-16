<#
.SYNOPSIS
    Typer 的输入宿主：用 Win32 SendInput 把键盘事件注入到当前前台窗口。

.DESCRIPTION
    由 Electron 主进程通过 stdin/stdout（JSON Lines，纯 ASCII）驱动，支持两类注入：

      1. 真实按键（t = "key"）      —— SendInput + 虚拟键码，需要 Shift 时同时按下修饰键；
                                      目标窗口按自己的键盘布局解释该按键。
      2. Unicode 报文（t = "unicode"）—— KEYEVENTF_UNICODE，直接投递一个 UTF-16 码元，
                                      绕过布局与输入法，用于中文/emoji 等没有物理键位的字符。

    之所以把注入放在独立的 PowerShell 进程里（而不是 Node 原生插件）：
    免去 node-gyp / MSVC 工具链，Windows 全版本自带 Windows PowerShell 5.1，
    运行时用 Add-Type 内联编译一小段 C# 即可。

    时序精度：Windows 默认定时器粒度约 15.6ms，`Start-Sleep -Milliseconds` 无法做到
    50ms 级别的精细节奏，因此等待逻辑使用 Stopwatch + SpinWait。

    取消策略：宿主在一个批次（request）内不读取 stdin，因此"紧急停止"的延迟上限
    就是一批动作的时长（由主进程按 chunk 控制）。

.PARAMETER DryRun
    只解析与校验动作，不真正调用 SendInput。用于系统自检与测试：可以验证
    Add-Type 编译、协议、C# 结构体布局，而不产生任何真实按键。

.EXAMPLE
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/typing-host.ps1
#>
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------------------
# 内联 C#：Win32 SendInput 与窗口查询
# ---------------------------------------------------------------------------
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TyperNative
{
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const uint KEYEVENTF_SCANCODE = 0x0008;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    // 必须与 Windows SDK 的 union 保持一致的尺寸，否则 SendInput 会返回 0
    // （ERROR_INVALID_PARAMETER）。仅放 KEYBDINPUT 会导致 sizeof(INPUT) 偏小。
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    public static int InputSize()
    {
        return Marshal.SizeOf(typeof(INPUT));
    }

    public static ushort VirtualKeyToScanCode(uint vk)
    {
        return (ushort)(MapVirtualKey(vk, 0) & 0xFFFF);
    }

    /// <summary>把一组按键事件作为一次原子调用发出（修饰键 + 主键在同一批里）。</summary>
    public static uint SendChord(ushort[] vks, ushort[] scans, uint[] flags)
    {
        int count = vks.Length;
        INPUT[] inputs = new INPUT[count];
        for (int i = 0; i < count; i++)
        {
            inputs[i].type = INPUT_KEYBOARD;
            inputs[i].U.ki.wVk = vks[i];
            inputs[i].U.ki.wScan = scans[i];
            inputs[i].U.ki.dwFlags = flags[i];
            inputs[i].U.ki.time = 0;
            inputs[i].U.ki.dwExtraInfo = IntPtr.Zero;
        }
        return SendInput((uint)count, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static long ForegroundWindow()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static string WindowTitle(long hwnd)
    {
        StringBuilder buffer = new StringBuilder(1024);
        GetWindowTextW(new IntPtr(hwnd), buffer, buffer.Capacity);
        return buffer.ToString();
    }

    public static uint WindowProcessId(long hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
        return pid;
    }

    public static bool IsKeyDown(int vk)
    {
        return (GetAsyncKeyState(vk) & 0x8000) != 0;
    }
}
'@

$compileError = $null
try {
    Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
} catch {
    $compileError = $_.Exception.Message
}

# ---------------------------------------------------------------------------
# 协议输出（纯 ASCII JSON Lines）
# ---------------------------------------------------------------------------
function ConvertTo-AsciiJson {
    param([Parameter(Mandatory = $true)] $Object)

    $json = $Object | ConvertTo-Json -Compress -Depth 12
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        $code = [int][char]$ch
        if ($code -ge 0x20 -and $code -le 0x7E) {
            [void]$builder.Append($ch)
        } else {
            [void]$builder.AppendFormat('\u{0:x4}', $code)
        }
    }
    return $builder.ToString()
}

function Send-Json {
    param([Parameter(Mandatory = $true)] $Object)

    [Console]::Out.WriteLine((ConvertTo-AsciiJson $Object))
    [Console]::Out.Flush()
}

function Send-Ok {
    param([int]$Id, $Data)

    if ($null -eq $Data) {
        Send-Json @{ id = $Id; ok = $true }
    } else {
        Send-Json @{ id = $Id; ok = $true; data = $Data }
    }
}

function Send-Fail {
    param([int]$Id, [string]$Code, [string]$Message, [string]$Detail)

    $errorObject = @{ code = $Code; message = $Message }
    if (-not [string]::IsNullOrEmpty($Detail)) {
        $errorObject.detail = $Detail
    }
    Send-Json @{ id = $Id; ok = $false; error = $errorObject }
}

# ---------------------------------------------------------------------------
# 高精度等待
# ---------------------------------------------------------------------------
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$ticksPerMs = [double][System.Diagnostics.Stopwatch]::Frequency / 1000.0

function Wait-Milliseconds {
    param([double]$Milliseconds)

    if ($Milliseconds -le 0) { return }

    $deadline = $stopwatch.ElapsedTicks + [long]($Milliseconds * $ticksPerMs)
    while ($stopwatch.ElapsedTicks -lt $deadline) {
        $remainingMs = ($deadline - $stopwatch.ElapsedTicks) / $ticksPerMs
        if ($remainingMs -gt 2.0) {
            # 留 1ms 余量，最后一段用 SpinWait 精修
            Start-Sleep -Milliseconds ([int]($remainingMs - 1.0))
        } else {
            [System.Threading.Thread]::SpinWait(40)
        }
    }
}

# ---------------------------------------------------------------------------
# 键位表
# ---------------------------------------------------------------------------
$modifierVk = @{
    shift = 0x10
    ctrl  = 0x11
    alt   = 0x12
    win   = 0x5B
}

# 需要 KEYEVENTF_EXTENDEDKEY 的虚拟键
$extendedKeys = @(
    0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E,
    0x5B, 0x5C, 0x5D, 0x6F, 0xA3, 0xA5, 0x90
)

function Test-ExtendedKey {
    param([int]$Vk)
    return $extendedKeys -contains $Vk
}

# ---------------------------------------------------------------------------
# 注入
# ---------------------------------------------------------------------------
$script:modifiersHeld = New-Object System.Collections.Generic.List[int]

function New-ChordBuilder {
    return @{
        vks   = (New-Object System.Collections.Generic.List[uint16])
        scans = (New-Object System.Collections.Generic.List[uint16])
        flags = (New-Object System.Collections.Generic.List[uint32])
    }
}

function Add-ChordEvent {
    param($Builder, [int]$Vk, [int]$Scan, [uint32]$Flags)
    [void]$Builder.vks.Add([uint16]$Vk)
    [void]$Builder.scans.Add([uint16]$Scan)
    [void]$Builder.flags.Add([uint32]$Flags)
}

function Add-KeyDown {
    param($Builder, [int]$Vk, [bool]$SendScan)

    $scan = 0
    if ($SendScan) { $scan = [TyperNative]::VirtualKeyToScanCode([uint32]$Vk) }
    $flags = [uint32]0
    if (Test-ExtendedKey -Vk $Vk) { $flags = $flags -bor 0x0001 }
    Add-ChordEvent -Builder $Builder -Vk $Vk -Scan $scan -Flags $flags
}

function Add-KeyUp {
    param($Builder, [int]$Vk, [bool]$SendScan)

    $scan = 0
    if ($SendScan) { $scan = [TyperNative]::VirtualKeyToScanCode([uint32]$Vk) }
    $flags = [uint32]0x0002
    if (Test-ExtendedKey -Vk $Vk) { $flags = $flags -bor 0x0001 }
    Add-ChordEvent -Builder $Builder -Vk $Vk -Scan $scan -Flags $flags
}

function Add-UnicodeEvent {
    param($Builder, [int]$CodeUnit, [bool]$KeyUp)

    # KEYEVENTF_UNICODE 要求 wVk = 0，字符放在 wScan（UTF-16 码元）
    $flags = [uint32]0x0004
    if ($KeyUp) { $flags = $flags -bor 0x0002 }
    Add-ChordEvent -Builder $Builder -Vk 0 -Scan $CodeUnit -Flags $flags
}

function Invoke-KeyAction {
    param($Item, [bool]$SendScan, [bool]$IsDryRun)

    $vk = [int]$Item.vk
    $mods = @($Item.mods)
    $builder = New-ChordBuilder

    foreach ($mod in $mods) {
        $modVk = $modifierVk[[string]$mod]
        if ($null -eq $modVk) {
            throw "未知修饰键：$mod"
        }
        Add-KeyDown -Builder $builder -Vk $modVk -SendScan $SendScan
        [void]$script:modifiersHeld.Add([int]$modVk)
    }

    Add-KeyDown -Builder $builder -Vk $vk -SendScan $SendScan
    Add-KeyUp -Builder $builder -Vk $vk -SendScan $SendScan

    for ($i = $mods.Count - 1; $i -ge 0; $i--) {
        $modVk = $modifierVk[[string]$mods[$i]]
        Add-KeyUp -Builder $builder -Vk $modVk -SendScan $SendScan
        [void]$script:modifiersHeld.Remove([int]$modVk)
    }

    if ($IsDryRun) { return [int]$builder.vks.Count }

    $sent = [TyperNative]::SendChord($builder.vks.ToArray(), $builder.scans.ToArray(), $builder.flags.ToArray())
    $expected = $builder.vks.Count
    if ($sent -ne $expected) {
        throw "SendInput 只注入了 $sent/$expected 个事件（可能被 UIPI 或安全软件拦截）"
    }
    return [int]$expected
}

function Invoke-UnicodeAction {
    param($Item, [bool]$IsDryRun)

    $codeUnit = [int]$Item.cu
    if ($codeUnit -lt 0 -or $codeUnit -gt 0xFFFF) {
        throw "非法的 UTF-16 码元：$codeUnit"
    }

    $builder = New-ChordBuilder
    Add-UnicodeEvent -Builder $builder -CodeUnit $codeUnit -KeyUp $false
    Add-UnicodeEvent -Builder $builder -CodeUnit $codeUnit -KeyUp $true

    if ($IsDryRun) { return [int]$builder.vks.Count }

    $sent = [TyperNative]::SendChord($builder.vks.ToArray(), $builder.scans.ToArray(), $builder.flags.ToArray())
    $expected = $builder.vks.Count
    if ($sent -ne $expected) {
        throw "SendInput 只注入了 $sent/$expected 个事件（可能被 UIPI 或安全软件拦截）"
    }
    return [int]$expected
}

function Invoke-ReleaseAll {
    param([bool]$IsDryRun)

    $released = 0
    # 先释放本次会话记录按下的修饰键（异常中断时可能残留）
    foreach ($vk in @($script:modifiersHeld)) {
        if (-not $IsDryRun) {
            $builder = New-ChordBuilder
            Add-KeyUp -Builder $builder -Vk $vk -SendScan $false
            [void][TyperNative]::SendChord($builder.vks.ToArray(), $builder.scans.ToArray(), $builder.flags.ToArray())
        }
        $released++
    }
    $script:modifiersHeld.Clear()

    # 再兜底释放所有修饰键（幂等，不会产生字符）
    foreach ($vk in @(0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5)) {
        if ($IsDryRun) { $released++; continue }
        $builder = New-ChordBuilder
        Add-KeyUp -Builder $builder -Vk $vk -SendScan $false
        [void][TyperNative]::SendChord($builder.vks.ToArray(), $builder.scans.ToArray(), $builder.flags.ToArray())
        $released++
    }

    return $released
}

function Get-ProbeResult {
    $stuck = New-Object System.Collections.Generic.List[int]
    foreach ($vk in @(0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5)) {
        if ([TyperNative]::IsKeyDown($vk)) { [void]$stuck.Add($vk) }
    }
    return @{ stuckKeys = @($stuck) }
}

# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
if ($null -ne $compileError) {
    [Console]::Error.WriteLine("Add-Type 编译失败：$compileError")
    Send-Fail -Id 0 -Code 'E_NATIVE_COMPILE' -Message '输入宿主编译失败' -Detail $compileError
    exit 1
}

$osDescription = [System.Environment]::OSVersion.VersionString
$psVersion = $PSVersionTable.PSVersion.ToString()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $request = $null
    try {
        $request = $line | ConvertFrom-Json
    } catch {
        Send-Fail -Id 0 -Code 'E_PARSE' -Message '无法解析请求行' -Detail $_.Exception.Message
        continue
    }

    $id = 0
    try { $id = [int]$request.id } catch { $id = 0 }

    try {
        switch ([string]$request.cmd) {
            'ping' {
                Send-Ok -Id $id -Data @{
                    os        = $osDescription
                    psVersion = $psVersion
                    dryRun    = [bool]$DryRun
                    inputSize = [TyperNative]::InputSize()
                }
            }

            'type' {
                $items = @($request.items)
                $sendScan = $true
                if ($null -ne $request.sendScanCodes) { $sendScan = [bool]$request.sendScanCodes }

                # requested / injected 都以"底层输入事件数"为单位：
                # 一个按键动作 = 按下 + 抬起 = 2 个事件（含修饰键时更多），
                # 这样才能真正校验 SendInput 是否把每个事件都投递成功。
                $expectedEvents = 0
                $injected = 0
                foreach ($item in $items) {
                    $delay = 0
                    if ($null -ne $item.delay) { $delay = [double]$item.delay }
                    Wait-Milliseconds -Milliseconds $delay

                    switch ([string]$item.t) {
                        'key' {
                            $expectedEvents += 2 + 2 * @($item.mods).Count
                            $injected += Invoke-KeyAction -Item $item -SendScan $sendScan -IsDryRun ([bool]$DryRun)
                        }
                        'unicode' {
                            $expectedEvents += 2
                            $injected += Invoke-UnicodeAction -Item $item -IsDryRun ([bool]$DryRun)
                        }
                        'wait' {
                            $ms = 0
                            if ($null -ne $item.ms) { $ms = [double]$item.ms }
                            Wait-Milliseconds -Milliseconds $ms
                        }
                        default { throw "未知动作类型：$($item.t)" }
                    }
                }

                Send-Ok -Id $id -Data @{
                    requested = $expectedEvents
                    injected  = $injected
                    items     = $items.Count
                }
            }

            'releaseAll' {
                $released = Invoke-ReleaseAll -IsDryRun ([bool]$DryRun)
                Send-Ok -Id $id -Data @{ released = $released }
            }

            'foreground' {
                $hwnd = [TyperNative]::ForegroundWindow()
                Send-Ok -Id $id -Data @{
                    hwnd  = $hwnd
                    pid   = [int][TyperNative]::WindowProcessId($hwnd)
                    title = [TyperNative]::WindowTitle($hwnd)
                }
            }

            'probe' {
                if ($DryRun) {
                    Send-Ok -Id $id -Data @{ stuckKeys = @() }
                } else {
                    Send-Ok -Id $id -Data (Get-ProbeResult)
                }
            }

            'shutdown' {
                Send-Ok -Id $id
                [Console]::Out.Flush()
                exit 0
            }

            default {
                Send-Fail -Id $id -Code 'E_UNKNOWN_CMD' -Message "未知指令：$($request.cmd)"
            }
        }
    } catch {
        # 任何动作异常都不应让宿主退出：回报错误，等待下一条指令
        Send-Fail -Id $id -Code 'E_INJECT_FAILED' -Message '注入失败' -Detail $_.Exception.Message
    }
}

exit 0
