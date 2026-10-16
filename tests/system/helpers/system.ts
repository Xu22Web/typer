import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** 仓库根目录（system 测试以它为基准定位脚本）。 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..')

export const HOST_SCRIPT = join(REPO_ROOT, 'scripts', 'typing-host.ps1')
export const TARGET_SCRIPT = join(REPO_ROOT, 'tests', 'system', 'fixtures', 'target-window.ps1')

/** Windows 自带的 Windows PowerShell 5.1 —— 与生产环境保持一致。 */
export const POWERSHELL = 'powershell.exe'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 运行一次性 PowerShell 命令并收集输出。 */
export function runPowershell(args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', ...args], {
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => resolveRun({ code, stdout, stderr }))

    if (input !== undefined) child.stdin?.write(input, 'utf8')
    child.stdin?.end()
  })
}

export function createTempDir(prefix = 'typer-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  description?: string
}

/** 轮询等待条件成立（等待窗口就绪 / 内容出现）。 */
export async function waitFor(predicate: () => boolean, options: WaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const intervalMs = options.intervalMs ?? 80
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }

  throw new Error(`等待超时（${timeoutMs}ms）：${options.description ?? '条件未满足'}`)
}

export interface TargetWindow {
  /** 目标窗口进程 pid（用于确认前台窗口是否就是它） */
  pid: number
  outFile: string
  keysFile: string
  readyFile: string
  logFile: string
  /** 字符级证据：目标窗口实际收到的字符流 */
  readKeys(): string
  /** 文本控件内容（焦点落在窗体而非控件上时可能为空） */
  readText(): string
  readLog(): string
  readyState(): string
  stop(): void
}

/**
 * 启动系统测试用的目标窗口。
 *
 * 之所以不用记事本：需要一个**可控、可读回**的目标；
 * WinForms 窗口把收到的字符写入文件，断言就变成纯文本比较。
 */
export async function launchTargetWindow(
  options: { timeoutSeconds?: number } = {}
): Promise<TargetWindow> {
  if (!existsSync(TARGET_SCRIPT)) {
    throw new Error(`找不到目标窗口脚本：${TARGET_SCRIPT}`)
  }

  const dir = createTempDir()
  const outFile = join(dir, 'out.txt')
  const child: ChildProcess = spawn(
    POWERSHELL,
    [
      '-STA',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      TARGET_SCRIPT,
      '-OutFile',
      outFile,
      '-TimeoutSeconds',
      String(options.timeoutSeconds ?? 90)
    ],
    { windowsHide: true }
  )

  if (!child.pid) throw new Error('目标窗口启动失败（没有 pid）')

  return {
    pid: child.pid,
    outFile,
    keysFile: `${outFile}.keys`,
    readyFile: `${outFile}.ready`,
    logFile: `${outFile}.log`,
    readKeys: () => safeRead(`${outFile}.keys`),
    readText: () => safeRead(outFile),
    readLog: () => safeRead(`${outFile}.log`),
    readyState: () => safeRead(`${outFile}.ready`).trim(),
    stop: () => {
      try {
        child.kill()
      } catch {
        // 忽略
      }
      removeTempDir(dir)
    }
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
