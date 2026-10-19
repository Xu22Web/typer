<#
.SYNOPSIS
    Typer 的输入宿主：用 Win32 SendInput 把键盘事件注入到当前前台窗口。

.DESCRIPTION
    由 Electron 主进程通过 stdin/stdout（JSON Lines，纯 ASCII）驱动，支持两类注入：

      1. 真实按键（t = "key"）—— SendInput + 虚拟键码，需要修饰键时先单独按下、留一个间隔，
                                 打完再抬起；目标窗口按自己的键盘布局解释该按键。

    为什么修饰键必须与主键分开：远程桌面（RDP / Citrix）会把同一次 SendInput 里的
    修饰键与主键合批，实测修饰键会被直接丢掉（Shift+1 到远端只剩 1）。拆成独立调用
    并在按下后等一小段（默认 15ms）才能让修饰键生效；抬起前同理留 10ms。
    连续需要同一修饰键的字符会保持按住，只在状态切换时付这个间隔。

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
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TyperNative
{
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
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

    // 高精度等待用的内核定时器。Windows 的默认定时器粒度约 15.6ms，Thread.Sleep(1) 实际会睡
    // 十几毫秒，所以这里用高分辨率可等待定时器（Win10 1803+）把等待时间交给内核；
    // 创建失败（老系统）时退回 timeBeginPeriod(1) + Sleep。
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWaitableTimerExW(IntPtr attributes, string name, uint flags, uint access);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetWaitableTimer(IntPtr timer, ref long dueTime, int period, IntPtr routine, IntPtr arg, bool resume);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint milliseconds);

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

    // -----------------------------------------------------------------------
    // 批量注入：把整个动作批（含 chord 组装）放在 C# 里做完，一次/几次 SendInput 发出去
    //
    // 为什么搬到这里：PowerShell 侧每字符要调 6~8 次函数、做 3 次数组拷贝，
    // 实测这部分开销与"每字符一次跨边界调用"叠加后会把吞吐压到百级；
    // 而让 C# 拿着扁平的整数数组直接组装 INPUT[]，可以省掉几乎全部托管侧开销。
    // 注意 Add-Type 在 Windows PowerShell 5.1 上用的是 C# 5 编译器，这里不能用
    // 字符串插值 / 表达式体成员等新语法。
    // -----------------------------------------------------------------------
    public const int OP_KEY = 0;
    public const int OP_WAIT = 1;

    public const int MOD_CTRL = 1;
    public const int MOD_SHIFT = 2;
    public const int MOD_ALT = 4;
    public const int MOD_WIN = 8;

    /// 单次 SendInput 最多提交的事件数。
    /// 批次越大，单次调用越容易被填满的输入队列拖住（实测阻塞时长可达数百毫秒），
    /// "停止"也就要等在途的那一次调用返回；256 个事件（128 个字符）是吞吐与响应性的折中。
    public const int MAX_EVENTS_PER_CALL = 256;

    /// 需要 KEYEVENTF_EXTENDEDKEY 的虚拟键（方向键、Home/End、小键盘除号等）
    private static readonly int[] ExtendedKeys = new int[] {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E,
        0x5B, 0x5C, 0x5D, 0x6F, 0xA3, 0xA5, 0x90
    };

    /// 修饰键的按下顺序（抬起时相反）。布局里每个键位最多带一个修饰键，因此顺序不构成行为差异。
    private static readonly int[] ModifierBits = new int[] { MOD_CTRL, MOD_SHIFT, MOD_ALT, MOD_WIN };
    private static readonly int[] ModifierVks = new int[] { 0x11, 0x10, 0x12, 0x5B };

    /// 本次会话按下的修饰键（供 releaseAll 优先释放）
    private static readonly List<int> HeldModifiers = new List<int>();
    private static readonly object HeldLock = new object();

    /// 当前保持按住的修饰键位掩码（跳批次保持：连续同修饰键的字符只付一次按下/抬起）
    private static int HeldModMask = 0;

    /// 紧急中止标志：由后台读线程在收到 cancel 指令时递增。
    ///
    /// 用"代次"而不是布尔值：每条指令入队时记下当时的中止代次，
    /// 只有代次在指令被读入之后又变过（说明 cancel 是这一批开始之后才到的）才打断。
    /// 否则上一轮遗留的 cancel 会误伤下一次运行的第一批。
    private static int CancelEpochValue = 0;

    /// 当前正在执行的批次所对应的中止代次（主线程专用，WaitMs 也读它）
    internal static int ActiveEpoch = 0;

    public static void RequestCancel()
    {
        System.Threading.Interlocked.Increment(ref CancelEpochValue);
    }

    public static int CancelEpoch
    {
        get { return System.Threading.Volatile.Read(ref CancelEpochValue); }
    }

    internal static bool StopRequested
    {
        get { return System.Threading.Volatile.Read(ref CancelEpochValue) != ActiveEpoch; }
    }

    public static int[] HeldModifierVks()
    {
        lock (HeldLock) { return HeldModifiers.ToArray(); }
    }

    public static void ClearHeldModifiers()
    {
        lock (HeldLock) { HeldModifiers.Clear(); }
        HeldModMask = 0;
    }

    private static bool IsExtended(int vk)
    {
        for (int i = 0; i < ExtendedKeys.Length; i++)
        {
            if (ExtendedKeys[i] == vk) return true;
        }
        return false;
    }

    private static INPUT KeyEvent(int vk, bool up, bool sendScan)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.U.ki.wVk = (ushort)vk;
        input.U.ki.wScan = sendScan ? VirtualKeyToScanCode((uint)vk) : (ushort)0;
        uint flags = up ? KEYEVENTF_KEYUP : 0;
        if (IsExtended(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        input.U.ki.dwFlags = flags;
        input.U.ki.time = 0;
        input.U.ki.dwExtraInfo = IntPtr.Zero;
        return input;
    }

    /// 自旋精修的尾段（毫秒）：这段用自旋保证节奏，其余时间交给内核定时器阻塞。
    /// 实测 2000 次 1ms 等待：尾段 0.3ms → 平均 1.10ms、CPU 0.16ms/次；
    /// 全程自旋 → 平均 1.00ms 但要 1.05ms CPU/次（吃满一个核，整台机器跟着卡）。
    private const double SPIN_TAIL_MS = 0.3;

    /// 压力阀阈值：一次 SendInput 超过这个时长就认为输入队列已经被填满。
    /// 正常（队列有空位）一次 32 个事件的 SendInput 只要几十微秒。
    private const double VALVE_TRIGGER_MS = 1.0;

    /// 压力阀的额外等待系数：阻塞本身已经把节奏拖慢了，这里只补一点让队列退到不饱和，
    /// 系数取 1 以上会把"目标端的真实速度"再打一次折（实测 2.0 时吞吐只剩 1/3）
    private const double VALVE_GAIN = 0.5;

    /// 压力阀单次补充上限（一次卡顿不该让后面的节奏冻住）
    private const double VALVE_MAX_EXTRA_MS = 4.0;

    /// 输入队列满时的重投预算：每个事件 64 条给 1 份，最少这么多毫秒。
    /// 超过就判定为"真的被拦截"（UIPI / 安全软件），让上层给出可读错误。
    private const double FLUSH_RETRY_BUDGET_MS = 3000.0;

    private const uint TIMER_ALL_ACCESS = 0x1F0003;
    private const uint CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x00000002;

    private static IntPtr WaitTimer = IntPtr.Zero;
    private static bool WaitTimerTried = false;

    /// 复用的事件缓冲区（单线程使用；SendInput 只读它）
    private static INPUT[] Scratch = new INPUT[MAX_EVENTS_PER_CALL];

    /// 重投"剩余事件"用的缓冲区（队列满时把后半段搬到头部再发）
    private static INPUT[] Retry = new INPUT[MAX_EVENTS_PER_CALL];

    /// 上一次 FlushBatch 里 SendInput 自身的耗时：压力阀靠它判断队列是否已经满了
    private static long LastFlushTicks = 0;

    private static IntPtr EnsureWaitTimer()
    {
        if (!WaitTimerTried)
        {
            WaitTimerTried = true;
            WaitTimer = CreateWaitableTimerExW(IntPtr.Zero, null, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
            if (WaitTimer == IntPtr.Zero) timeBeginPeriod(1);
        }
        return WaitTimer;
    }

    /// 精确等待：内核定时器阻塞掉大头，最后 0.3ms 自旋精修
    private static void WaitMs(double ms)
    {
        if (ms <= 0) return;
        long ticksPerMs = Stopwatch.Frequency / 1000;
        long deadline = Stopwatch.GetTimestamp() + (long)(ms * ticksPerMs);
        IntPtr timer = EnsureWaitTimer();

        while (true)
        {
            if (StopRequested) return;
            long remainingTicks = deadline - Stopwatch.GetTimestamp();
            if (remainingTicks <= 0) return;
            double remainingMs = (double)remainingTicks / ticksPerMs;
            if (remainingMs <= SPIN_TAIL_MS)
            {
                Thread.SpinWait(60);
                continue;
            }

            double blockMs = remainingMs - SPIN_TAIL_MS;
            if (timer != IntPtr.Zero)
            {
                long due = -(long)(blockMs * 10000.0); // 负数 = 相对时间，单位 100ns
                SetWaitableTimer(timer, ref due, 0, IntPtr.Zero, IntPtr.Zero, false);
                WaitForSingleObject(timer, (uint)Math.Ceiling(blockMs) + 20);
            }
            else
            {
                int sleepMs = (int)Math.Floor(blockMs);
                Thread.Sleep(sleepMs < 1 ? 1 : sleepMs);
            }
        }
    }

    private static int FlushBatch(List<INPUT> pending, bool dryRun)
    {
        int count = pending.Count;
        LastFlushTicks = 0;
        if (count == 0) return 0;
        if (dryRun) { pending.Clear(); return count; }

        // 复用一块缓冲区：每批都 ToArray() 会在高吞吐时产生大量短命数组
        if (Scratch.Length < count) Scratch = new INPUT[count];
        pending.CopyTo(Scratch, 0);
        pending.Clear();

        // SendInput 对"目标输入队列已满"的表现是**少注入或不注入**，而不是报错：
        // 控制台窗口的输入队列只有百来条记录，一次投 256 个事件必定装不下。
        // 这些事件必须重投，绝不能当成"注入完成"（那等于静默丢字符），也不能直接失败
        // （那会让 15 位档的大批次永远打不完）。所以这里按"已注入数"重投剩余部分，
        // 每次重投前让队列排空一小会儿；超过期限才判定为真的被拦截。
        long started = Stopwatch.GetTimestamp();
        double deadlineMs = FLUSH_RETRY_BUDGET_MS * Math.Max(1, count / 64.0);
        int offset = 0;
        double waitedMs = 0;
        while (offset < count)
        {
            if (StopRequested) break; // 已被中止：剩余事件丢弃，由调用方按 cancelled 处理
            int remaining = count - offset;
            INPUT[] batch = Scratch;
            if (offset > 0)
            {
                // 重投时把剩余事件搬到缓冲区头部（SendInput 只能从数组起点发）
                if (Retry.Length < remaining) Retry = new INPUT[remaining];
                Array.Copy(Scratch, offset, Retry, 0, remaining);
                batch = Retry;
            }
            uint sent = SendInput((uint)remaining, batch, Marshal.SizeOf(typeof(INPUT)));
            offset += (int)sent;
            if (offset >= count) break;

            // 队列满了：等一下再重投。等待量从 1ms 起，随重试次数缓慢增长。
            double pauseMs = Math.Min(8.0, 1.0 + waitedMs * 0.5);
            WaitMs(pauseMs);
            waitedMs += pauseMs;
            if (waitedMs > deadlineMs)
            {
                LastFlushTicks = Stopwatch.GetTimestamp() - started;
                throw new InvalidOperationException(
                    "SendInput 只注入了 " + offset + "/" + count + " 个事件（等待 " +
                    (int)waitedMs + "ms 后输入队列仍未排空：可能被 UIPI 或安全软件拦截）");
            }
        }
        LastFlushTicks = Stopwatch.GetTimestamp() - started;
        return offset;
    }

    /// <summary>
    /// 每次 flush 之后都要记一次账（不只带延迟的断批）：
    /// 零延迟的大批次同样会把输入队列灌满，只是没有"下一个等待"可以借机降速。
    /// 返回值是本次应当补等的毫秒数，0 表示队列还有空位。
    /// </summary>
    private static double ValveWaitAfterFlush(bool dryRun, long ticksPerMs,
        ref int blockedCalls, ref double blockedMs, ref double maxBlockedMs, ref double valveMs)
    {
        if (dryRun) return 0;
        double flushMs = (double)LastFlushTicks / ticksPerMs;
        if (flushMs > maxBlockedMs) maxBlockedMs = flushMs;
        if (flushMs < VALVE_TRIGGER_MS) return 0;
        blockedCalls++;
        blockedMs += flushMs;
        double extra = flushMs * VALVE_GAIN;
        if (extra > VALVE_MAX_EXTRA_MS) extra = VALVE_MAX_EXTRA_MS;
        valveMs += extra;
        return extra;
    }

    /// 把修饰键位掩码对应的键事件追加进列表（按下或抬起）
    private static void AppendModifierKeys(List<INPUT> list, int mask, bool up, bool sendScan)
    {
        for (int i = 0; i < ModifierBits.Length; i++)
        {
            if ((mask & ModifierBits[i]) == 0) continue;
            int modVk = ModifierVks[i];
            list.Add(KeyEvent(modVk, up, sendScan));
            lock (HeldLock)
            {
                if (up) HeldModifiers.Remove(modVk);
                else if (!HeldModifiers.Contains(modVk)) HeldModifiers.Add(modVk);
            }
        }
    }

    /// 修饰键状态从 from 过渡到 to：先松开不再需要的（等 tail），再按下新需要的（等 lead）。
    ///
    /// 为什么必须拆成独立调用并留间隔：远程桌面客户端会把同一次 SendInput 里的修饰键与主键
    /// 合批处理，实测 Shift 在这种批次里会被直接丢弃（Shift+1 到远端只剩 1）；拆开后 10ms 即够。
    /// @returns 本次过渡实际注入的事件数
    private static int ApplyModifierTransition(int from, int to, bool dryRun, int leadMs, int tailMs, bool sendScan)
    {
        int removeMask = from & ~to;
        int addMask = to & ~from;
        if (removeMask == 0 && addMask == 0) return 0;

        int injected = 0;
        if (removeMask != 0)
        {
            List<INPUT> ups = new List<INPUT>(ModifierBits.Length);
            AppendModifierKeys(ups, removeMask, true, sendScan);
            injected += FlushBatch(ups, dryRun);
            if (tailMs > 0) WaitMs(tailMs);
        }
        if (addMask != 0)
        {
            List<INPUT> downs = new List<INPUT>(ModifierBits.Length);
            AppendModifierKeys(downs, addMask, false, sendScan);
            injected += FlushBatch(downs, dryRun);
            if (leadMs > 0) WaitMs(leadMs);
        }
        return injected;
    }

    /// 释放一批虚拟键（只发抬起事件）。用于 releaseAll：一次调用发完整批，避免逐个 VK 一次 SendInput。
    public static int SendKeyUps(int[] vks, bool dryRun)
    {
        if (vks.Length == 0) return 0;
        if (dryRun) return vks.Length;

        List<INPUT> pending = new List<INPUT>(vks.Length);
        for (int i = 0; i < vks.Length; i++)
        {
            pending.Add(KeyEvent(vks[i], true, false));
        }
        return FlushBatch(pending, false);
    }

    /// 一次请求的全部动作：组装 chord、按 delay 断批、注入。
    /// 返回 { requested, injected, blockedMs, maxBlockedMs, valveMs, blockedCalls }：
    /// 前两个以底层输入事件数计，后四个是"目标端消化不过来"的证据（毫秒 / 次数）。
    ///
    /// 约定：`delays[i]` 是"执行第 i 个动作之前要等多久"；纯等待动作（OP_WAIT）把时长也放在
    /// 这里、`vals[i]` 留 0，于是它天然走"断批 + 等待"这条路径，不需要单独分支。
    ///
    /// 压力阀：SendInput 把事件交给系统输入流后立即返回，但目标线程消化不过来时队列会被填满，
    /// 之后的每次 SendInput 都要在队列里等空位（实测一次调用从几十微秒涨到几毫秒）。队列常年
    /// 是满的时候，整台机器的输入处理都会排在它后面——鼠标都会卡。所以这里把"被拖住的时长"
    /// 按倍数补进下一次等待，让队列回到不饱和的状态；节奏因此会自适应到目标端真正跟得上的速度。
    ///
    /// `perItem`：每个动作单独一次 SendInput。数据帧（文件传输）必须开启——实测真实终端下
    /// 一次投递多个字符时，目标端输入缓冲紧张会静默丢掉其中一部分；逐动作投递则零丢失。
    public static int[] SendBatch(int[] ops, int[] vals, int[] mods, double[] delays, bool sendScan, bool perItem, int modLeadMs, int modTailMs, bool dryRun, int cancelEpoch)
    {
        int requested = 0;
        int injected = 0;
        int blockedCalls = 0;
        double blockedMs = 0;
        double maxBlockedMs = 0;
        double valveMs = 0;
        long ticksPerMs = Stopwatch.Frequency / 1000;
        List<INPUT> pending = new List<INPUT>(256);
        ActiveEpoch = cancelEpoch;

        for (int i = 0; i < ops.Length; i++)
        {
            // 中止：丢掉还没提交的事件。每个按键都是完整的 down/up 对（含修饰键），
            // 整对丢弃不会留下按下的键，因此这里不需要先 Flush 再退出。
            if (StopRequested)
            {
                pending.Clear();
                return new int[] {
                    requested, injected,
                    (int)Math.Round(blockedMs), (int)Math.Round(maxBlockedMs),
                    (int)Math.Round(valveMs), blockedCalls, 1
                };
            }

            double delay = delays[i];
            if (delay > 0)
            {
                // 有停顿才断批：先送出手头的事件，再等待，保证"什么时候打出去"与逐动作发送一致
                injected += FlushBatch(pending, dryRun);
                double flushMs = (double)LastFlushTicks / ticksPerMs;
                double extra = ValveWaitAfterFlush(dryRun, ticksPerMs,
                    ref blockedCalls, ref blockedMs, ref maxBlockedMs, ref valveMs);
                // 阻塞本身已经是"等待"：把它从下个间隔里扣掉，否则队列排满时会被重复计入，
                // 实际吞吐会掉到目标端能力的三分之一
                double remaining = delay - (flushMs < delay ? flushMs : delay);
                if (remaining > 0) WaitMs(remaining);
                if (extra > 0) WaitMs(extra);
            }

            int op = ops[i];
            if (op == OP_KEY)
            {
                int modifiers = mods[i];
                if ((modifiers & ~(MOD_CTRL | MOD_SHIFT | MOD_ALT | MOD_WIN)) != 0)
                {
                    throw new ArgumentOutOfRangeException("mods", "未知的修饰键位：" + modifiers);
                }
                // 修饰键状态切换：事件数按“新增 + 移除”计，再算主键的 down/up 两个
                int removeMask = HeldModMask & ~modifiers;
                int addMask = modifiers & ~HeldModMask;
                for (int b = 0; b < ModifierBits.Length; b++)
                {
                    if ((removeMask & ModifierBits[b]) != 0) requested++;
                    if ((addMask & ModifierBits[b]) != 0) requested++;
                }
                requested += 2;

                injected += ApplyModifierTransition(HeldModMask, modifiers, dryRun, modLeadMs, modTailMs, sendScan);
                HeldModMask = modifiers;

                pending.Add(KeyEvent(vals[i], false, sendScan));
                pending.Add(KeyEvent(vals[i], true, sendScan));
            }
            else if (op != OP_WAIT)
            {
                throw new ArgumentOutOfRangeException("ops", "未知动作类型：" + op);
            }

            if (pending.Count >= (perItem ? 2 : MAX_EVENTS_PER_CALL))
            {
                injected += FlushBatch(pending, dryRun);
                // 没有计划等待可以"借机"降速时，就在这里补等：否则零延迟大批次会长期占满输入队列
                double extra = ValveWaitAfterFlush(dryRun, ticksPerMs,
                    ref blockedCalls, ref blockedMs, ref maxBlockedMs, ref valveMs);
                if (extra > 0) WaitMs(extra);
            }
        }

        injected += FlushBatch(pending, dryRun);
        // 最后一批只记账、不再补等（后面没有动作了，补等只会白等）
        ValveWaitAfterFlush(dryRun, ticksPerMs,
            ref blockedCalls, ref blockedMs, ref maxBlockedMs, ref valveMs);
        return new int[] {
            requested,
            injected,
            (int)Math.Round(blockedMs),
            (int)Math.Round(maxBlockedMs),
            (int)Math.Round(valveMs),
            blockedCalls,
            StopRequested ? 1 : 0
        };
    }
}

/// 标准输入的后台读取：主线程可能长时间停在 SendBatch 里（慢目标下一批要几百毫秒），
/// 因此把读 stdin 放到独立线程：cancel 指令当场置位中止标志，其余指令排队交给主线程。
public static class TyperHostPipe
{
    /// 一条待处理指令：正文 + 读入时的中止代次
    public sealed class Line
    {
        public string Text;
        public int Epoch;

        public Line(string text, int epoch)
        {
            Text = text;
            Epoch = epoch;
        }
    }

    private static readonly System.Collections.Concurrent.BlockingCollection<Line> Queue =
        new System.Collections.Concurrent.BlockingCollection<Line>();
    private static bool Started = false;

    public static void Start()
    {
        if (Started) return;
        Started = true;
        Thread reader = new Thread(ReadLoop);
        reader.IsBackground = true;
        reader.Name = "typer-stdin";
        reader.Start();
    }

    private static void ReadLoop()
    {
        while (true)
        {
            string line;
            try { line = Console.In.ReadLine(); }
            catch { line = null; }
            if (line == null)
            {
                Queue.CompleteAdding();
                return;
            }
            if (line.IndexOf("\"cancel\"", StringComparison.Ordinal) >= 0)
            {
                TyperNative.RequestCancel();
                continue;
            }
            if (line.Trim().Length == 0) continue;
            // 记下读入这一刻的代次：之后再来的 cancel 才算"这一批的中止"
            try { Queue.Add(new Line(line, TyperNative.CancelEpoch)); }
            catch (InvalidOperationException) { return; }
        }
    }

    /// 取下一条待处理指令；stdin 关闭后返回 null
    public static Line Take()
    {
        try { return Queue.Take(); }
        catch (InvalidOperationException) { return null; }
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
# ---------------------------------------------------------------------------
# 释放修饰键
# ---------------------------------------------------------------------------
function Invoke-ReleaseAll {
    param([bool]$IsDryRun)

    # 先释放本次会话记录按下的修饰键（异常中断时可能残留），再兜底释放所有修饰键（幂等、不产生字符）
    $held = @([TyperNative]::HeldModifierVks())
    [TyperNative]::ClearHeldModifiers()
    $targets = @($held) + @(0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5)

    $unique = New-Object System.Collections.Generic.List[int]
    foreach ($vk in $targets) {
        $value = [int]$vk
        if (-not $unique.Contains($value)) { [void]$unique.Add($value) }
    }

    return [TyperNative]::SendKeyUps($unique.ToArray(), $IsDryRun)
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

# 读 stdin 交给后台线程：主线程在注入时也要能立刻收到 cancel
[TyperHostPipe]::Start()

while ($true) {
    $message = [TyperHostPipe]::Take()
    if ($null -eq $message) { break }
    $line = $message.Text
    $epoch = $message.Epoch
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
                # 扁平数组（协议 v2）：ops/vals/mods/delays 一一对应，chord 组装在 C# 里完成，
                # 这样每字符不再产生多次 PowerShell 函数调用与数组拷贝
                $ops = @($request.ops)
                $vals = @($request.vals)
                $mods = @($request.mods)
                $delays = @($request.delays)
                $sendScan = $true
                if ($null -ne $request.sendScanCodes) { $sendScan = [bool]$request.sendScanCodes }
                # 数据帧：每个动作单独一次 SendInput（一次投递多个字符时，目标端输入缓冲紧张会静默丢字符）
                $perItem = $request.perItem -eq $true
                # 修饰键与主键必须分成独立调用并留间隔：远程桌面会把同批的修饰键合批丢弃
                $modLeadMs = 15
                if ($null -ne $request.modLeadMs) { $modLeadMs = [int]$request.modLeadMs }
                if ($modLeadMs -lt 0) { $modLeadMs = 0 }
                $modTailMs = 10
                if ($null -ne $request.modTailMs) { $modTailMs = [int]$request.modTailMs }
                if ($modTailMs -lt 0) { $modTailMs = 0 }

                if ($ops.Count -ne $vals.Count -or $ops.Count -ne $mods.Count -or $ops.Count -ne $delays.Count) {
                    throw "协议错误：ops/vals/mods/delays 长度不一致"
                }

                $count = $ops.Count
                $opArray = New-Object int[] $count
                $valArray = New-Object int[] $count
                $modArray = New-Object int[] $count
                $delayArray = New-Object double[] $count
                for ($i = 0; $i -lt $count; $i++) {
                    $opArray[$i] = [int]$ops[$i]
                    $valArray[$i] = [int]$vals[$i]
                    $modArray[$i] = [int]$mods[$i]
                    $delayArray[$i] = [double]$delays[$i]
                }

                $result = [TyperNative]::SendBatch($opArray, $valArray, $modArray, $delayArray, $sendScan, $perItem, $modLeadMs, $modTailMs, [bool]$DryRun, [int]$epoch)

                # 顺带把"本批结束时谁在前台"带回去：焦点守护每批都要查一次，
                # 单独发一条 foreground 指令会多一次进程往返（实测约 1ms/批）
                $hwnd = [TyperNative]::ForegroundWindow()
                Send-Ok -Id $id -Data @{
                    requested    = [int]$result[0]
                    injected     = [int]$result[1]
                    items        = $count
                    blockedMs    = [int]$result[2]
                    maxBlockedMs = [int]$result[3]
                    valveMs      = [int]$result[4]
                    blockedCalls = [int]$result[5]
                    cancelled    = ([int]$result[6] -eq 1)
                    foreground   = @{
                        hwnd  = $hwnd
                        pid   = [int][TyperNative]::WindowProcessId($hwnd)
                        title = [TyperNative]::WindowTitle($hwnd)
                    }
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
