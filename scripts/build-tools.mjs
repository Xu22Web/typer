// 把 tools/ 下的接收端 TS 源码打包成目标机可直接运行的**单行** ESM 文件（tools/typer-recv.mjs），
// 并生成同目录的启动脚本 tools/run.bat。
// 目标机（用户要"把文件从本机传到另一台机器"）通常没有 npm / 没有构建环境，因此产物必须：
//   · 单文件自包含（除 node: 内置模块外不引入任何第三方依赖）；
//   · 兼容 Node 16（很多老机器只有 Node 16），所以构建后要自检有没有用到更高版本才有的 API；
//   · 能直接 `node typer-recv.mjs` 跑（ESM，靠 .mjs 扩展名让 Node 按模块解析）；
//   · **整份只有一行、且不含任何注释**：这份产物会被 Typer 逐字符打进目标机的编辑器再保存，
//     单行省掉每行的回车（个别场合还能整段粘进单行输入框），注释则纯属白打的字符
//     （更危险的是 `//` 注释——在单行文件里它会把后半截整段吞掉）；
//   · 尽量小：体积直接决定输入耗时。
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
const batFile = join(root, 'tools', 'run.bat')

/**
 * 反斜杠用字符码拼出来：下面要把"裸换行"改写成 `\n` 这种**转义文本**（两个字符），
 * 直接写 `'\\n'` 要穿好几层转义，很容易写成真换行而看不出问题。
 */
const BACKSLASH = String.fromCharCode(92)

/** 换行 → 它在字面量里的转义写法（保持字符串取值不变，同时让整份文件只剩一行） */
const LINE_BREAK_ESCAPE = new Map([
  ['\r\n', `${BACKSLASH}r${BACKSLASH}n`],
  ['\r', `${BACKSLASH}r`],
  ['\n', `${BACKSLASH}n`]
])

/**
 * Node 16 上不存在或易踩的 API：产物里出现即说明兼容性被破坏。
 * 用字符串匹配是因为产物是打包后的单行文件，脚本里拿不到 AST。
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
 * @description 在文本里找出所有命中片段，返回 "第 N 行 / 偏移 M" 形式的位置描述
 * （产物是单行文件，只报行号等于什么都没说，所以同时给出字符偏移）
 * @param text 待检查文本
 * @param needle 要查找的片段
 * @returns 命中位置列表（最多 5 条，避免刷屏）
 */
function locate(text, needle) {
  const hits = []
  let from = 0
  while (hits.length < 5) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    const line = text.slice(0, at).split('\n').length
    const start = Math.max(0, at - 40)
    hits.push(`第 ${line} 行 / 偏移 ${at}: …${text.slice(start, at + needle.length + 40)}…`)
    from = at + needle.length
  }
  return hits
}

/**
 * @description 把 esbuild 的产物压成一行。
 *
 * esbuild 即使开了 minify 也会在**模板字面量内部**保留裸换行：它按字节数挑最省的写法，
 * 而 `` `a\nb` `` 比 `"a\nb"` 短，所以产物从来不是严格的一行。裸换行只可能是两种情况：
 * 字面量里的内容（改写会改变取值，必须还成等价的 \n 转义）；或者代码里的语句分隔
 * （改写会变成字符串外的转义序列 → 直接语法错误）。后者交给下面的一致性校验挡下来。
 * @param code esbuild 产物全文
 * @returns 单行文本（不含任何换行）
 */
function toSingleLine(code) {
  const body = code.replace(/(?:\r\n|\r|\n)$/, '')
  return body.replace(/\r\n|\r|\n/g, (breakChar) => LINE_BREAK_ESCAPE.get(breakChar))
}

/**
 * @description 把代码规范化成"无模板字面量、无换行"的形式，用来判断两份代码语义是否一致。
 *
 * esbuild 关掉模板字面量（`supported: { 'template-literal': false }`）后会把 `` `a${b}c` ``
 * 降级成 `"a"+b+"c"`，字面量内容因此被统一转义；于是"压行前后"只剩语义差异才会让结果不同。
 * 刻意不混淆标识符：同名同频时的取名顺序会随输入形态漂移（实测压行前后把两个变量换了个位置），
 * 那是假差异，会把能通过的产物判成失败。
 * @param code 待规范化的代码
 * @returns 规范化结果（单行）
 */
async function canonical(code) {
  const result = await esbuild.transform(code, {
    loader: 'js',
    target: 'node16',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
    supported: { 'template-literal': false }
  })
  return result.code.trim()
}

/**
 * @description 兜底写法：关掉模板字面量重打一遍（同时照常压缩、混淆），产物必定只有一行
 * @param code esbuild 产物全文
 * @returns 单行文本
 */
async function safeSingleLine(code) {
  const result = await esbuild.transform(code, {
    loader: 'js',
    target: 'node16',
    minify: true,
    legalComments: 'none',
    supported: { 'template-literal': false }
  })
  return result.code.trim()
}

/**
 * @description 打包成单行产物；压行结果过不了一致性校验时退回"降级模板字面量"的保守写法
 * @returns 产物全文与选中的写法说明
 */
async function bundle() {
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

  const built = await esbuild.build({
    stdin: {
      // 源码里若有 shebang 一律去掉：单行产物放不下它（要独占第一行），run.bat 直接调 node
      contents: source.replace(/^#![^\n]*\r?\n/, ''),
      loader: 'ts',
      resolveDir: dirname(entry),
      sourcefile: 'typer-recv.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node16',
    // 压缩：产物要作为文本打进目标终端，体积就是输入耗时。
    // 注释也由 minify 一并去掉（legalComments: none 连许可证注释都不留）
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    write: false
  })
  const raw = built.outputFiles[0].text

  try {
    const candidate = toSingleLine(raw)
    if ((await canonical(candidate)) !== (await canonical(raw))) {
      throw new Error('压行后的规范化代码与压行前不一致')
    }
    return { code: candidate, style: '紧凑压行' }
  } catch (error) {
    // 兜底：关掉模板字面量重印一遍，产物一定是单行，代价是字符串拼接写法多占约 4% 体积
    const fallback = await safeSingleLine(raw)
    console.warn(
      `！压行的一致性校验没通过（${error instanceof Error ? error.message : String(error)}），` +
        '改用它更保守的写法：模板字面量降级为字符串拼接（体积略大，仍然单行）'
    )
    return { code: fallback, style: '模板字面量降级' }
  }
}

/** @description 打包 + 自检；任何一项失败都让进程以非 0 退出 */
async function main() {
  const { code, style } = await bundle()
  writeFileSync(outfile, code)

  const output = readFileSync(outfile, 'utf8')
  const problems = []

  if (/[\r\n]/.test(output)) {
    problems.push(['产物里还有换行 —— 它必须能整份当作一整行输入', locate(output, '\n')])
  }

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

  // 自包含校验：除 Node 内置模块外不应引用任何外部模块（产物要能整份拷到目标机直接跑）。
  // 产物是单行文件，不能再按"行首 import/export"去匹配，直接找所有 from "…" 的模块名
  const external = new Set()
  for (const match of output.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
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

  // 真跑一次自检：压行会不会改坏字面量（\n 转义、模板拼接）只有实际执行才能确认
  const selftest = spawnSync(process.execPath, [outfile, '--selftest'], { encoding: 'utf8' })
  if (selftest.status !== 0 || !(selftest.stdout || '').includes('自检通过')) {
    problems.push([
      `产物 --selftest 没通过：\n${(selftest.stderr || selftest.stdout || '').trim()}`,
      []
    ])
    console.error(
      `✗ 产物 --selftest 没通过：\n${(selftest.stderr || selftest.stdout || '').trim()}`
    )
  }

  const bytes = statSync(outfile).size
  console.log(`tools/typer-recv.mjs  ${bytes} bytes / ${output.length} 字符（单行，${style}）`)

  writeFileSync(batFile, RUN_BAT)
  console.log(`tools/run.bat         ${statSync(batFile).size} bytes`)

  console.log(`自检：${problems.length === 0 ? '通过' : `失败（${problems.length} 项）`}`)

  if (problems.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('打包接收端失败：', error)
  process.exit(1)
})
