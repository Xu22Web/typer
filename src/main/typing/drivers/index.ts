import type { ClipboardLike } from './clipboard'
import { resolveHostScriptPath, type HostLocatorContext } from './hostLocator'
import type { KeyboardDriver } from './KeyboardDriver'
import { nodeSpawnAdapter } from './spawn'
import {
  isSupportedPlatform,
  unsupportedPlatformError,
  WindowsSendInputDriver
} from './WindowsSendInputDriver'

export type { ClipboardLike } from './clipboard'
export type { KeyboardDriver } from './KeyboardDriver'
export { MockKeyboardDriver } from './MockKeyboardDriver'
export { WindowsSendInputDriver } from './WindowsSendInputDriver'

export interface CreateDriverOptions {
  platform: NodeJS.Platform | string
  clipboard: ClipboardLike
  locator: HostLocatorContext
  dryRun?: boolean
  restoreClipboard?: boolean
  requestTimeoutMs?: number
  maxRestarts?: number
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

/**
 * 驱动工厂。
 *
 * 测试里直接构造 `MockKeyboardDriver`；这里只负责"真实运行"所需的装配，
 * 因此平台判断与非 Windows 报错也集中在此处，便于断言。
 */
export function createDriver(options: CreateDriverOptions): KeyboardDriver {
  if (!isSupportedPlatform(options.platform)) {
    throw unsupportedPlatformError(String(options.platform))
  }

  return new WindowsSendInputDriver({
    spawn: nodeSpawnAdapter,
    hostScriptPath: resolveHostScriptPath(options.locator),
    clipboard: options.clipboard,
    dryRun: options.dryRun,
    restoreClipboard: options.restoreClipboard,
    requestTimeoutMs: options.requestTimeoutMs,
    maxRestarts: options.maxRestarts,
    onLog: options.onLog
  })
}
