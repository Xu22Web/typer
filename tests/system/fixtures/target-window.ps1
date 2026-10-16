<#
.SYNOPSIS
    系统测试用的"输入目标窗口"。

.DESCRIPTION
    一个 WinForms 窗口，内含文本控件，把收到的输入写回文件，供系统测试断言。

    写出的文件：
      <OutFile>.ready —— `ready:focus` / `ready:nofocus`：是否成功抢到前台焦点
      <OutFile>       —— 文本控件的当前内容
      <OutFile>.keys  —— **字符级证据**：在消息循环层（IMessageFilter）捕获的 WM_CHAR 流
      <OutFile>.log   —— KeyDown / KeyPress / TextChanged 事件流水，便于诊断

    为什么用 IMessageFilter 而不是控件的 KeyPress：
    控件的 KeyPress 会把代理对（emoji）交给 .NET 的字符校验处理，实际会丢掉低代理码元；
    而 IMessageFilter 看到的是**原始 WM_CHAR 的 wParam**，与"操作系统到底投递了哪些码元"
    完全一致，并且与焦点落在窗体还是控件上无关。

    安全前提：注入前必须确保本窗口是前台窗口，否则按键会打到用户其它窗口上。
    因此这里用 AttachThreadInput + SetForegroundWindow 主动抢焦点，并把结果写进 .ready；
    测试脚本必须先检查该标记（并配合宿主 foreground 命令）再注入。

.NOTES
    必须用 -STA 启动（WinForms 需要单线程单元）。
#>
param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$TimeoutSeconds = 90,
    [ValidateSet('text', 'rich')][string]$ControlType = 'text'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TyperFocus
{
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    public static bool ForceForeground(IntPtr hWnd)
    {
        IntPtr current = GetForegroundWindow();
        if (current == hWnd) return true;

        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(current, out targetPid);
        uint myThread = GetCurrentThreadId();

        bool attached = AttachThreadInput(myThread, targetThread, true);
        try
        {
            ShowWindow(hWnd, 9); // SW_RESTORE
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
        }
        finally
        {
            if (attached) AttachThreadInput(myThread, targetThread, false);
        }
        return GetForegroundWindow() == hWnd;
    }
}
'@

# 在消息循环层记录 WM_CHAR：拿到的是原始 UTF-16 码元，不受控件字符校验影响
Add-Type -ReferencedAssemblies 'System.Windows.Forms' -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class TyperMessageRecorder : IMessageFilter
{
    private const int WM_CHAR = 0x0102;

    private readonly string _path;
    private readonly StringBuilder _buffer = new StringBuilder();

    public TyperMessageRecorder(string path)
    {
        _path = path;
    }

    public string Content
    {
        get { return _buffer.ToString(); }
    }

    public bool PreFilterMessage(ref Message m)
    {
        if (m.Msg == WM_CHAR)
        {
            char unit = (char)(m.WParam.ToInt64() & 0xFFFF);
            _buffer.Append(unit);
            // 注意：中间状态可能包含"半个代理对"，无法编码为 UTF-8（会写成替换字符），
            // 但只要两个码元都到达，最终写入的内容就是完整的 emoji。
            try
            {
                File.WriteAllText(_path, _buffer.ToString(), new UTF8Encoding(false));
            }
            catch
            {
                // 忽略写入失败
            }
        }
        return false;
    }
}
'@

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$readyFile = "$OutFile.ready"
$logFile = "$OutFile.log"
$keysFile = "$OutFile.keys"

$recorder = New-Object TyperMessageRecorder($keysFile)
[System.Windows.Forms.Application]::AddMessageFilter($recorder)

$log = {
    param([string]$Message)
    try {
        [System.IO.File]::AppendAllText($logFile, "$(Get-Date -Format 'HH:mm:ss.fff')  $Message`r`n", $utf8NoBom)
    } catch {
        # 忽略
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'typer-system-test-target'
$form.Size = New-Object System.Drawing.Size(720, 320)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.TopMost = $true
$form.ShowInTaskbar = $true

if ($ControlType -eq 'rich') {
    $box = New-Object System.Windows.Forms.RichTextBox
} else {
    $box = New-Object System.Windows.Forms.TextBox
}
$box.Dock = 'Fill'
$box.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 16)
$box.Multiline = $true
$box.AcceptsTab = $true
$box.ShortcutsEnabled = $false
$form.Controls.Add($box)

$publish = {
    try {
        [System.IO.File]::WriteAllText($OutFile, $box.Text, $utf8NoBom)
    } catch {
        # 忽略：写入失败不应影响窗口继续接收输入
    }
}

$box.add_TextChanged({
        & $log "TextChanged: $($box.Text)"
        & $publish
    })
$box.add_KeyDown({
        & $log "box KeyDown: $($_.KeyCode)"
    })
$box.add_KeyPress({
        & $log "box KeyPress: $([int][char]$_.KeyChar)"
    })
$form.add_KeyPress({
        & $log "form KeyPress: $([int][char]$_.KeyChar)"
    })
$form.add_Activated({
        [void]$box.Focus()
    })

# 定时把文本控件内容刷到文件（不依赖某个事件一定触发），并记录一次焦点状态
$script:loggedFocus = $false
$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 150
$poll.add_Tick({
        if (-not $box.Focused -and $form.Visible) { [void]$box.Focus() }
        & $publish
        if (-not $script:loggedFocus) {
            $script:loggedFocus = $true
            & $log "focus snapshot: foreground=$([TyperFocus]::GetForegroundWindow()) form=$($form.Handle) boxFocused=$($box.Focused)"
        }
    })
$poll.Start()

$form.add_Shown({
        [void]$box.Focus()
        & $publish
        $state = if ([TyperFocus]::ForceForeground($form.Handle)) { 'ready:focus' } else { 'ready:nofocus' }
        try { [System.IO.File]::WriteAllText($readyFile, $state, $utf8NoBom) } catch { }
        & $log "shown; state=$state; form=$($form.Handle) boxFocused=$($box.Focused)"

        # 短时间内重试抢焦点（Windows 前台锁有时会拒绝第一次请求）
        $retry = New-Object System.Windows.Forms.Timer
        $retry.Interval = 300
        $script:attempts = 0
        $retry.add_Tick({
                $script:attempts++
                $ok = [TyperFocus]::ForceForeground($form.Handle)
                if ($ok -or $script:attempts -ge 8) {
                    $retry.Stop()
                    $state = if ($ok) { 'ready:focus' } else { 'ready:nofocus' }
                    try { [System.IO.File]::WriteAllText($readyFile, $state, $utf8NoBom) } catch { }
                    & $log "focus retry done: $state (attempts=$script:attempts)"
                }
            })
        $retry.Start()
    })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $TimeoutSeconds) * 1000
$timer.add_Tick({
        $timer.Stop()
        & $publish
        # 关闭前把消息层捕获的完整字符流落盘（测试的主要断言依据）
        try { [System.IO.File]::WriteAllText($keysFile, $recorder.Content, $utf8NoBom) } catch { }
        $form.Close()
    })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
