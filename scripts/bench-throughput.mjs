#!/usr/bin/env node
/**
 * 注入吞吐基准（不进入默认 CI）。
 *
 * 默认只跑 **dry-run**：只测协议与宿主循环能跑多快，不产生任何按键。
 * 加 `--real "<窗口标题>"` 才会真正注入——脚本会先把该窗口切到前台，再把字符打进去，
 * 因此务必自己指定一个可丢弃的窗口（例如一个空白记事本）。
 *
 * 输出每种模式的"发送耗时 / 等效字符每秒 / 被输入队列拖住的时长 / 压力阀补等"，
 * 用来判断瓶颈到底在管线还是目标程序。
 *
 * 用法：
 *   node scripts/bench-throughput.mjs
 *   node scripts/bench-throughput.mjs --real "无标题 - 记事本" --chars 1000
 *
 * 文件传输的字符数 / 各档位耗时不在这个脚本里：用 `scripts/bench-transfer.mjs`，
 * 它直接复用主进程的准备实现，并与界面上的字符档口径一致。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const hostScript = join(root, 'scripts', 'typing-host.ps1')

const args = process.argv.slice(2)
const realIndex = args.indexOf('--real')
const targetTitle = realIndex >= 0 ? args[realIndex + 1] : ''
const charsArg = args.indexOf('--chars')
const totalChars = charsArg >= 0 ? Number(args[charsArg + 1]) : 2000
const dryRun = !targetTitle

/** @description 把目标窗口切到前台（只给 --real 用） */
function focusWindow(title) {
  const script = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class B{[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}'
$h = [B]::FindWindow($null, '${title.replace(/'/g, "''")}')
if ($h -eq [IntPtr]::Zero) { exit 1 }
[void][B]::SetForegroundWindow($h)
`
  return spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true
  })
}

const host = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    hostScript,
    ...(dryRun ? ['-DryRun'] : [])
  ],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
)

const pending = new Map()
let nextId = 1
createInterface({ input: host.stdout }).on('line', (line) => {
  const text = line.trim()
  if (!text) return
  const message = JSON.parse(text)
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message)
  }
})
host.stderr.on('data', (chunk) => process.stderr.write(chunk))

/**
 * @description 发送一条指令并等待响应
 * @param cmd 指令名
 * @param payload 负载
 * @returns 响应数据
 */
function request(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`等待 ${cmd} 超时`)), 180_000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      if (message.ok === false) reject(new Error(JSON.stringify(message)))
      else resolve(message.data ?? message)
    })
    host.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`)
  })
}

/** @description 造一批 Unicode 动作 */
function unicodeBatch(count, delayMs) {
  return {
    ops: new Array(count).fill(1),
    vals: new Array(count).fill(0x61),
    mods: new Array(count).fill(0),
    delays: new Array(count).fill(delayMs)
  }
}

/**
 * @description 跑一种节奏并输出统计
 * @param label 名称
 * @param perRequest 每请求动作数
 * @param delayMs 每个动作的延迟
 * @returns 统计结果
 */
async function bench(label, perRequest, delayMs) {
  if (!dryRun) focusWindow(targetTitle)
  const startedAt = Date.now()
  let blockedMs = 0
  let valveMs = 0
  for (let sent = 0; sent < totalChars; sent += perRequest) {
    const size = Math.min(perRequest, totalChars - sent)
    const data = await request('type', unicodeBatch(size, delayMs))
    blockedMs += data.blockedMs ?? 0
    valveMs += data.valveMs ?? 0
  }
  const elapsed = Date.now() - startedAt
  const rate = Math.round((totalChars * 1000) / elapsed)
  console.log(
    `${label.padEnd(28)} ${String(elapsed).padStart(6)}ms  ${String(rate).padStart(5)} 字符/秒  ` +
      `阻塞 ${blockedMs}ms  阀补等 ${valveMs}ms`
  )
  return { elapsed, rate, blockedMs, valveMs }
}

await request('ping')
console.log(
  `模式：${dryRun ? 'dry-run（不产生按键）' : `真实注入 → 「${targetTitle}」`}，` +
    `共 ${totalChars} 字符\n` +
    '模式                          耗时      吞吐          队列压力'
)

await bench('稳健 1ms/字符 × 256/批', 256, 1)
await bench('极速 0 延迟 × 512/批', 512, 0)
await bench('极速 0 延迟 × 128/批', 128, 0)

host.stdin.end()
host.kill()
