// 把 tools/ 下的接收端 TS 源码打包成目标机可直接运行的单个 ESM 文件（tools/typer-recv.mjs），
// 并生成同目录的启动脚本 tools/run.bat。
// 目标机（用户要"把文件从本机传到另一台机器"）通常没有 npm / 没有构建环境，因此产物必须：
//   · 单文件自包含（除 node: 内置模块外不引入任何第三方依赖）；
//   · 兼容 Node 16（很多老机器只有 Node 16），所以构建后要自检有没有用到更高版本才有的 API；
//   · 能直接 `node typer-recv.mjs` 跑（ESM，靠 .mjs 扩展名让 Node 按模块解析）；
//   · 尽量小：这份产物会作为文本被 Typer"打"进目标终端，体积直接决定输入耗时。
// 用 `pnpm build:tools` 运行（dev / build / test 脚本已自动串联）。
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'tools', 'typer-recv.ts')
const outfile = join(root, 'tools', 'typer-recv.mjs')

/**
 * 产物头部说明，会被原样写进产物顶部。刻意保持极短：这段文字也会被用户"打"进目标终端，
 * 只交代无法从代码里看出来的两件事——它是构建产物、以及必须保留 .mjs 扩展名。
 */
const BANNER = [
  '#!/usr/bin/env node',
  '// Typer 文件接收端（构建产物，勿手改；源码与改动见 tools/typer-recv.ts）。',
  '// 需保留 .mjs 扩展名（Node 按扩展名解析 ESM），Node >= 16。用法：node typer-recv.mjs --help / --selftest'
].join('\n')

/**
 * Node 16 上不存在或易踩的 API：产物里出现即说明兼容性被破坏。
 * 用字符串匹配是因为产物是打包后的单文件，脚本里拿不到 AST。
 */
const FORBIDDEN_APIS = [
  'structuredClone',
  '.at(',
  'findLast',
  'Object.hasOwn',
  'AbortSignal.timeout'
]

/**
 * 随产物一起生成的启动脚本：目标机双击即可运行接收端，省去手敲 `node typer-recv.mjs`。
 * 内容只用 ASCII —— .bat 由 cmd 按当前控制台代码页逐字节解释，写中文会随机器乱码；
 * 行尾必须是 CRLF，否则带标签的跳转在部分 cmd 版本上不生效。
 */
const RUN_BAT = [
  '@echo off',
  'rem Typer file receiver launcher: forwards all arguments to node.',
  'setlocal',
  'where node >nul 2>nul',
  'if errorlevel 1 goto :no_node',
  'node "%~dp0typer-recv.mjs" %*',
  'exit /b %errorlevel%',
  '',
  ':no_node',
  'echo Node.js not found on PATH. Install Node 16 or newer, then run this file again.',
  'pause',
  'exit /b 1',
  ''
].join('\r\n')

/**
 * @description 在文本里找出所有命中片段，返回 "第 N 行: 内容" 形式的位置描述
 * @param text 待检查文本
 * @param needle 要查找的片段
 * @returns 命中位置列表（最多 5 条，避免刷屏）
 */
function locate(text, needle) {
  const lines = text.split('\n')
  const hits = []
  for (let i = 0; i < lines.length && hits.length < 5; i++) {
    if (lines[i].includes(needle)) hits.push(`第 ${i + 1} 行: ${lines[i].trim().slice(0, 120)}`)
  }
  return hits
}

/** @description 打包 + 自检；任何一项失败都让进程以非 0 退出 */
async function main() {
  let source
  try {
    source = readFileSync(entry, 'utf8')
  } catch {
    console.error(`找不到接收端源码：${entry}`)
    console.error(
      '接收端源码从 src/main/util/frame 导入线格式实现；确认该文件存在后重新运行本脚本。'
    )
    process.exit(1)
  }

  // shebang 一律由 banner 提供，源码里若有则去掉
  await esbuild.build({
    stdin: {
      contents: source.replace(/^#![^\n]*\r?\n/, ''),
      loader: 'ts',
      resolveDir: dirname(entry),
      sourcefile: 'typer-recv.ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node16',
    // 压缩：产物要作为文本打进目标终端，体积就是输入耗时
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    banner: { js: BANNER }
  })

  const output = readFileSync(outfile, 'utf8')
  const problems = []

  if (output.includes('require(')) {
    problems.push([
      '产物里出现了 require( —— ESM 产物不该包含 CJS require',
      locate(output, 'require(')
    ])
  }

  for (const api of FORBIDDEN_APIS) {
    if (output.includes(api)) {
      problems.push([`产物里出现了 Node 16 不可用 / 易踩的 API：${api}`, locate(output, api)])
    }
  }

  // 自包含校验：除 Node 内置模块外不应引用任何外部模块（产物要能整份拷到目标机直接跑）
  const external = new Set()
  for (const match of output.matchAll(
    /(?:^|\n)\s*(?:import|export)[^\n]*?from\s*['"]([^'"]+)['"]/g
  )) {
    const specifier = match[1]
    if (!specifier.startsWith('node:') && !isBuiltin(specifier)) external.add(specifier)
  }
  if (external.size > 0) {
    problems.push([`产物引用了非 Node 内置模块：${[...external].join(', ')}`, []])
  }

  for (const [message, hits] of problems) {
    console.error(`✗ ${message}`)
    for (const hit of hits) console.error(`    ${hit}`)
  }

  // 语法检查：node --check 会按 ES Module 解析产物，挡住语法层面的低级错误
  const check = spawnSync(process.execPath, ['--check', outfile], { encoding: 'utf8' })
  if (check.status !== 0) {
    problems.push([`node --check 失败：\n${(check.stderr || '').trim()}`, []])
    console.error(`✗ node --check 失败：\n${(check.stderr || '').trim()}`)
  }

  const bytes = statSync(outfile).size
  console.log(`tools/typer-recv.mjs  ${bytes} bytes`)

  const batFile = join(root, 'tools', 'run.bat')
  writeFileSync(batFile, RUN_BAT)
  console.log(`tools/run.bat         ${statSync(batFile).size} bytes`)

  console.log(`自检：${problems.length === 0 ? '通过' : `失败（${problems.length} 项）`}`)

  if (problems.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('打包接收端失败：', error)
  process.exit(1)
})
