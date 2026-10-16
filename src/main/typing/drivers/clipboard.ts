import { ProtocolError } from './protocol'

/** Electron `clipboard` 的最小接口，便于测试注入。 */
export interface ClipboardLike {
  readText(): string
  writeText(text: string): void
}

export interface PasteOptions {
  clipboard: ClipboardLike
  /** 真正按下 Ctrl+V 的动作（由驱动实现） */
  sendPaste: () => Promise<void>
  text: string
  /** 是否在粘贴结束后恢复用户原来的剪贴板内容 */
  restoreClipboard: boolean
}

export interface PasteResult {
  restored: boolean
}

/**
 * 剪贴板回退：长文本或目标程序不认 Unicode 报文时，用"写入剪贴板 + Ctrl+V"代替逐字输入。
 *
 * 关键约束：**无论成功还是失败都要恢复用户剪贴板**（`restoreClipboard=true` 时），
 * 否则会静默破坏用户正在使用的内容。
 */
export async function pasteWithClipboard(options: PasteOptions): Promise<PasteResult> {
  const { clipboard, sendPaste, text, restoreClipboard } = options
  const previous = restoreClipboard ? clipboard.readText() : null

  try {
    clipboard.writeText(text)
    await sendPaste()
  } catch (error) {
    throw new ProtocolError(
      'E_CLIPBOARD',
      '剪贴板粘贴失败',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    if (restoreClipboard && previous !== null) {
      try {
        clipboard.writeText(previous)
      } catch {
        // 恢复失败不应掩盖真正的错误
      }
    }
  }

  return { restored: restoreClipboard }
}
