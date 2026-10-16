import { spawn } from 'node:child_process'
import type { ChildProcessLike, SpawnFn } from './powershellDriver'

/**
 * @description 生产环境的 spawn 适配器：把 Node 的 `ChildProcess` 收敛成测试用的最小接口，
 * 全项目只有这一处类型转换
 * @param command 可执行文件
 * @param args 命令行参数
 * @param options 工作目录、环境变量与窗口隐藏选项
 * @returns 最小子进程接口
 */
export const nodeSpawnAdapter: SpawnFn = (command, args, options) =>
  spawn(command, [...args], options) as unknown as ChildProcessLike
