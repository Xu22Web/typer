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
 * @description 驱动工厂：只做"真实运行"所需的装配（测试直接构造 `MockKeyboardDriver`），
 * 平台判断与非 Windows 报错也集中在此，便于断言
 * @param options 平台、剪贴板、宿主定位与注入选项
 * @returns Windows 键盘注入驱动
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
