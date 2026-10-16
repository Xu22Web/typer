import { spawn } from 'node:child_process'
import type { ChildProcessLike, SpawnFn } from './powershellDriver'

/**
 * 生产环境使用的 spawn 适配器。
 * Node 的 `ChildProcess` 类型比测试用的最小接口复杂得多，这里收敛成一处类型转换。
 */
export const nodeSpawnAdapter: SpawnFn = (command, args, options) =>
  spawn(command, [...args], options) as unknown as ChildProcessLike
