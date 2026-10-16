// 以 TYPIST_E2E=1 运行系统测试项目（真实注入用例）。
// pnpm 在 Windows 上无法用 `VAR=1 cmd` 语法设置环境变量，因此用 Node 转发。
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitestEntry = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')

const child = spawn(process.execPath, [vitestEntry, 'run', '--project', 'system'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TYPIST_E2E: '1' }
})

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
