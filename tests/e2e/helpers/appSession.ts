/**
 * 端到端夹具：启动**真实应用**（electron-vite dev + 远程调试端口）并连上它的渲染进程。
 *
 * 两条硬约束决定了这里的做法：
 *
 * 1. **不能真的按键**：宿主以 dry-run 启动（主进程读 `TYPER_DRY_RUN=1`），协议、事件计数、
 *    节奏全部照走，但一次 `SendInput` 都不发，因此在开发机上跑不会把字打到别的窗口。
 * 2. **不能污染真实配置**：把子进程的 `APPDATA` 指到临时目录，`app.getPath('userData')`
 *    随之落在这里，`settings.json`、缓存、日志都与开发者本机的 `%APPDATA%\Typer` 隔离。
 *
 * 不注入按键不等于“看不到结果”：宿主额外把**本来会发出**的按键事件记进 `recordPath`
 * （`-Record`），测试用它重放出“目标窗口本该收到的文本”，再与源内容 / 接收端还原结果逐字节比对。
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { CdpClient, sleep, waitFor, type CdpTarget } from './cdp'

const run = promisify(execFile)

/** 仓库根目录（本文件在 tests/e2e/helpers 下） */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 调试端口：默认 9333，避开日常调试常用的 9222 */
export const E2E_PORT = Number(process.env['TYPER_E2E_PORT'] ?? 9333)

/** 启动允许的最长时间：首次启动要编译主进程与预加载脚本 */
const START_TIMEOUT_MS = 120_000

/** 单次输入任务允许的最长时间 */
export const RUN_TIMEOUT_MS = 180_000

export interface E2EApp {
  /** 主窗口渲染进程的 CDP 客户端 */
  cdp: CdpClient
  /** 子进程输出（失败时打印，便于定位） */
  log: string[]
  /** 调试端口 */
  port: number
  /** 宿主按键记录文件（每行 `vk,up`）：用来重放出“目标窗口本该收到的文本” */
  recordPath: string
  /** 结束应用、断开连接并清理临时目录 */
  stop: () => Promise<void>
}

/**
 * @description 读取调试端口上的目标列表（应用还没起来时返回空数组）
 * @param port 调试端口
 * @returns 目标列表
 */
async function listTargets(port: number): Promise<CdpTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return []
    return (await response.json()) as CdpTarget[]
  } catch {
    return []
  }
}

/**
 * @description 等到某个调试目标（页面）出现
 * @param port 调试端口
 * @param match 目标筛选条件
 * @param label 超时时的说明
 * @returns 命中的页面目标
 */
export async function findPage(
  port: number,
  match: (target: CdpTarget) => boolean,
  label: string
): Promise<CdpTarget> {
  return waitFor(
    async () => {
      const targets = await listTargets(port)
      return targets.find((target) => target.type === 'page' && match(target)) ?? null
    },
    { timeoutMs: START_TIMEOUT_MS, intervalMs: 400, label }
  )
}

/**
 * @description 杀掉整棵进程树（Windows 上 electron-vite 会再拉起 Electron 子进程）
 * @param child 由本夹具启动的进程
 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
  await sleep(600)
}

export interface E2EAppOptions {
  /**
   * 预置的“用户选择结果”：按顺序回答主进程的原生文件对话框（`TYPER_PICK_PATHS`）。
   *
   * 原生对话框由操作系统绘制，没有可靠的注入点，`SendKeys` / UI Automation 都要依赖前台焦点
   * 与会话状态（远程桌面、锁屏、多显示器下尤其不稳）。这里改用应用层的显式开关，
   * 让「选择文件」这一步的结果确定，从而能把**界面按钮**到终态的整条链路都跑起来。
   */
  pickPaths?: string[]
}

/**
 * @description 启动应用、连上主窗口并等 preload 暴露 `window.api`
 * @param options 启动选项
 * @returns 端到端夹具
 */
export async function startE2EApp(options: E2EAppOptions = {}): Promise<E2EApp> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'typer-e2e-data-'))
  const appData = join(dataRoot, 'APPDATA')
  mkdirSync(appData, { recursive: true })

  const cli = resolve(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const recordPath = join(dataRoot, 'keys.txt')
  const log: string[] = []
  const child = spawn(process.execPath, [cli, 'dev', '--remoteDebuggingPort', String(E2E_PORT)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // 宿主：只走协议，不真的注入按键
      TYPER_DRY_RUN: '1',
      // 但把“本来会发出”的按键事件记下来，供测试重放内容
      TYPER_RECORD_PATH: recordPath,
      // 「选择文件」的预置答案（未传时不设置该变量，主进程照常弹真实对话框）
      ...(options.pickPaths && options.pickPaths.length > 0
        ? { TYPER_PICK_PATHS: options.pickPaths.join(';') }
        : {}),
      // 配置与缓存隔离，绝不碰本机真实的 %APPDATA%\Typer
      APPDATA: appData
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const collect = (chunk: unknown): void => {
    log.push(String(chunk))
    // 只留最近的一段：出问题时够定位，又不会把测试输出撑爆
    if (log.length > 400) log.shift()
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  let cdp: CdpClient | null = null

  try {
    const page = await findPage(
      E2E_PORT,
      (target) =>
        typeof target.webSocketDebuggerUrl === 'string' && !target.url.includes('float.html'),
      '主窗口出现在调试端口上'
    )
    if (!page.webSocketDebuggerUrl) throw new Error('主窗口没有 webSocketDebuggerUrl')

    cdp = await CdpClient.connect(page.webSocketDebuggerUrl)
    const client = cdp

    // 渲染进程要等 preload 装好 window.api 才能被驱动
    await waitFor(
      async () => client.evaluate<boolean>('Boolean(window.api && window.api.typing)'),
      { timeoutMs: 60_000, intervalMs: 200, label: 'preload 暴露 window.api' }
    )

    // 首帧在 dev 下要现编译视图与组件，外壳先出现、内容后到：这里等到输入页真的渲染出来
    await waitFor(
      async () => client.evaluate<boolean>("Boolean(document.querySelector('#tour-start button'))"),
      { timeoutMs: START_TIMEOUT_MS, intervalMs: 300, label: '输入页渲染完成' }
    )

    return {
      cdp: client,
      log,
      port: E2E_PORT,
      recordPath,
      stop: async () => {
        client.close()
        await stopChild(child)
        rmSync(dataRoot, { recursive: true, force: true })
      }
    }
  } catch (error) {
    cdp?.close()
    await stopChild(child)
    rmSync(dataRoot, { recursive: true, force: true })
    const tail = log.join('').split('\n').slice(-40).join('\n')
    throw new Error(
      `启动端到端应用失败：${error instanceof Error ? error.message : String(error)}\n--- 应用日志 ---\n${tail}`
    )
  }
}

/**
 * @description 把设置调成"跑得快且不依赖焦点"的一组值（测试自己控制，不读用户配置）
 * @param cdp 主窗口 CDP 客户端
 * @returns 设置写入完成的 Promise
 */
export async function applyFastSettings(cdp: CdpClient): Promise<void> {
  await cdp.evaluate(`(async () => {
    await window.api.settings.set({
      startDelayMs: 150,
      focusGuard: 'off',
      seed: 1,
      update: { checkOnStartup: false },
      floating: { finishBehavior: 'manual' },
      injection: { profile: 'normal', minDelayMs: 0 },
      modifier: { leadMs: 15, tailMs: 10 },
      text: { newlineKey: 'enter', lineStart: 'off' },
      timing: {
        speedMode: 'interval',
        baseIntervalMs: 1,
        jitterMs: 0,
        wordPauseMs: 0,
        punctuationPauseMs: 0,
        newlinePauseMs: 0,
        paragraphPauseMs: 0,
        burstSize: 0,
        burstPauseMs: 0
      },
      typo: { rate: 0 }
    })
    return true
  })()`)
}

/**
 * @description 造一个待传输的临时文件（内容全是 ASCII，各字符档都能编码）
 * @returns 临时目录与文件路径
 */
export function makeSampleFile(): { dir: string; file: string; bytes: number } {
  const dir = mkdtempSync(join(tmpdir(), 'typer-e2e-file-'))
  const file = join(dir, 'sample.txt')
  const lines = Array.from(
    { length: 40 },
    (_, index) =>
      `line ${String(index + 1).padStart(3, '0')} - the quick brown fox jumps over 42 lazy dogs`
  )
  const content = `${lines.join('\n')}\n`
  writeFileSync(file, content, 'utf8')
  return { dir, file, bytes: Buffer.byteLength(content) }
}

/**
 * @description 清空宿主记录文件（每次运行前调用，确保只重放本次的按键）
 * @param recordPath 宿主记录文件路径
 */
export function resetRecording(recordPath: string): void {
  writeFileSync(recordPath, '')
}

/**
 * @description 读取宿主记录下来的按键行（文件还没创建时返回空数组）
 * @param recordPath 宿主记录文件路径
 * @returns 形如 `vk,up` 的行
 */
export function readRecordedLines(recordPath: string): string[] {
  if (!existsSync(recordPath)) return []
  return readFileSync(recordPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * @description 定位接收端脚本（构建产物，由 `pnpm build:tools` 从 tools/typer-recv.ts 打包生成）
 * @returns 脚本绝对路径
 */
export function receiverPath(): string {
  const path = join(repoRoot, 'tools', 'typer-recv.mjs')
  if (!existsSync(path)) {
    throw new Error(
      `缺少接收端构建产物 ${path}：请先运行 pnpm build:tools（由 tools/typer-recv.ts 打包生成）`
    )
  }
  return path
}

/**
 * @description 真实跑一遍接收端（把重放出来的帧文本喂给它，让它还原文件）
 * @param args 接收端参数
 * @param cwd 工作目录（相对路径参数以它为基准）
 * @param scriptPath 要执行的接收端脚本；缺省为仓库里的构建产物
 * @returns 退出码与输出
 */
export async function runReceiver(
  args: string[],
  cwd: string,
  scriptPath: string = receiverPath()
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [scriptPath, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}
