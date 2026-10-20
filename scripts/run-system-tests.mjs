// 以 TYPIST_E2E=1 运行系统测试项目（真实注入用例）。
// pnpm 在 Windows 上无法用 `VAR=1 cmd` 语法设置环境变量，因此用 Node 转发。
// 托管 CI runner 上真实注入到不了目标窗口，用例自己会按 `CI` 跳过（见 tests/system/realInjection.spec.ts）。
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitestEntry = resolve(root, 'node_modules', 'vitest', 'vitest.mjs')

// 系统测试在这台机器上要跑一两分钟（真实窗口 + 真实进程），默认报告器只在整轮跑完后才出结果，
// 看不出"卡在哪一个用例"；verbose 报告器逐条实时打印，配合 stdout 重定向也能看到进度。
const child = spawn(
  process.execPath,
  [vitestEntry, 'run', '--project', 'system', '--reporter=verbose'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TYPIST_E2E: '1' }
  }
)

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
