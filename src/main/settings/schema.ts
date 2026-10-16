import type { EngineSettings, InsertMode } from '../typing/engine/TypingEngine'
import type { FocusGuardMode } from '../typing/focus/focusGuard'
import { isLayoutId, type LayoutId } from '../typing/planner/keymap'
import type { JitterDistribution, SpeedMode } from '../typing/scheduling/timing'
import type { TypoCorrection, TypoStyle } from '../typing/scheduling/typo'
import { TRANSFER_LIMITS, type TransferEncoding } from '@shared/transfer/transfer'
import type { ImportCharset, LogLevel, Settings } from './types'

export type { ImportCharset, LogLevel, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  startDelayMs: 3000,
  insertMode: 'auto',
  autoPasteThreshold: 500,
  chunkSize: 8,
  seed: 0,
  timing: {
    speedMode: 'cps',
    cps: 6,
    wpm: 120,
    baseIntervalMs: 80,
    jitterMs: 25,
    distribution: 'gaussian',
    wordPauseMs: 0,
    punctuationPauseMs: 120,
    newlinePauseMs: 250,
    paragraphPauseMs: 600,
    burstSize: 40,
    burstPauseMs: 400
  },
  typo: {
    rate: 0.02,
    style: 'adjacent',
    correction: 'auto'
  },
  keyboard: {
    layout: 'us',
    forceUnicodeForAll: false
  },
  focusGuard: 'warn',
  hotkeys: {
    // 只支持 Windows：用 Ctrl 而不是 CommandOrControl（后者在 Windows 上也等价于 Ctrl，
    // 但显示出来会让人以为需要 Command 键）
    stop: 'Ctrl+Alt+X',
    togglePause: 'Ctrl+Alt+P'
  },
  privacy: {
    persistContent: false,
    persistSettings: true
  },
  clipboard: {
    restore: true,
    importCharset: 'auto'
  },
  transfer: {
    encoding: 'hex',
    chunkBytes: 1024,
    maxFrameChars: 4096,
    interFrameDelayMs: 400,
    pasteFrameIncludesNewline: true
  },
  update: {
    checkOnStartup: true
  },
  verifyStuckKeys: true,
  logLevel: 'info'
}

/** 每个数值字段的合法区间与默认值，用于“夹取”非法输入。 */
export const NUMERIC_BOUNDS = {
  startDelayMs: [0, 60_000],
  autoPasteThreshold: [100, 100_000],
  chunkSize: [1, 64],
  seed: [0, 0xffffffff],
  cps: [0.5, 50],
  wpm: [10, 1000],
  baseIntervalMs: [1, 2000],
  jitterMs: [0, 500],
  wordPauseMs: [0, 1000],
  punctuationPauseMs: [0, 2000],
  newlinePauseMs: [0, 5000],
  paragraphPauseMs: [0, 5000],
  burstSize: [0, 1000],
  burstPauseMs: [0, 10_000],
  typoRate: [0, 0.2],
  chunkBytes: [64, 1024 * 1024],
  maxFrameChars: [256, 1024 * 1024]
} as const satisfies Record<string, readonly [number, number]>

type BoundsKey = keyof typeof NUMERIC_BOUNDS

/**
 * @description 读取数值字段并把越界值夹取到合法区间
 * @param raw 原始对象
 * @param key 字段名
 * @param fallback 类型错误时的默认值
 * @param bounds 合法区间
 * @returns 夹取后的数值
 */
function readNumber(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  bounds: readonly [number, number]
): number {
  const value = raw[key]
  const [min, max] = bounds
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * @description 读取布尔字段
 * @param raw 原始对象
 * @param key 字段名
 * @param fallback 类型错误时的默认值
 * @returns 布尔值
 */
function readBool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * @description 读取枚举字段，只接受白名单内的取值
 * @param raw 原始对象
 * @param key 字段名
 * @param allowed 允许的取值
 * @param fallback 不在白名单内时的默认值
 * @returns 合法的枚举值
 */
function readEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = raw[key]
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/**
 * @description 读取字符串字段
 * @param raw 原始对象
 * @param key 字段名
 * @param fallback 类型错误时的默认值
 * @returns 字符串值
 */
function readString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * @description 把快捷键文案里跨平台遗留的 `Command` / `CommandOrControl` 统一成 `Ctrl`
 * @param accelerator 原始加速键文本
 * @returns 规范化后的加速键文本
 */
function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/CmdOrCtrl/gi, 'Ctrl')
    .replace(/\bCommand\b/gi, 'Ctrl')
    .replace(/\bCmd\b/gi, 'Ctrl')
}

/**
 * @description 把未知值收窄成普通对象（非对象时给空对象）
 * @param value 候选值
 * @returns 普通对象
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const SPEED_MODES: readonly SpeedMode[] = ['cps', 'wpm', 'interval']
const DISTRIBUTIONS: readonly JitterDistribution[] = ['uniform', 'gaussian']
const INSERT_MODES: readonly InsertMode[] = ['keystroke', 'paste', 'auto']
const TYPO_STYLES: readonly TypoStyle[] = ['adjacent', 'lookalike', 'transpose']
const TYPO_CORRECTIONS: readonly TypoCorrection[] = ['auto', 'none']
const FOCUS_MODES: readonly FocusGuardMode[] = ['off', 'warn', 'strict']
const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug']
const CHARSETS: readonly ImportCharset[] = ['auto', 'utf8', 'utf16le', 'gbk']
const TRANSFER_ENCODING_VALUES: readonly TransferEncoding[] = ['hex', 'b64', 'txt']

/**
 * @description 把任意（旧版本或被手工编辑过的）JSON 归一化为合法设置；类型错误回退默认值、超范围夹取、未知字段丢弃，且永不抛错
 * @param raw 原始 JSON 值
 * @returns 完整的合法设置
 */
export function normalizeSettings(raw: unknown): Settings {
  const root = asRecord(raw)
  const timing = asRecord(root.timing)
  const typo = asRecord(root.typo)
  const keyboard = asRecord(root.keyboard)
  const hotkeys = asRecord(root.hotkeys)
  const privacy = asRecord(root.privacy)
  const clipboard = asRecord(root.clipboard)
  const update = asRecord(root.update)
  const transfer = asRecord(root.transfer)
  const bounds = NUMERIC_BOUNDS

  const layoutValue = keyboard.layout
  const layout: LayoutId =
    typeof layoutValue === 'string' && isLayoutId(layoutValue)
      ? layoutValue
      : DEFAULT_SETTINGS.keyboard.layout

  return {
    startDelayMs: readNumber(
      root,
      'startDelayMs',
      DEFAULT_SETTINGS.startDelayMs,
      bounds.startDelayMs
    ),
    insertMode: readEnum(root, 'insertMode', INSERT_MODES, DEFAULT_SETTINGS.insertMode),
    autoPasteThreshold: readNumber(
      root,
      'autoPasteThreshold',
      DEFAULT_SETTINGS.autoPasteThreshold,
      bounds.autoPasteThreshold
    ),
    chunkSize: readNumber(root, 'chunkSize', DEFAULT_SETTINGS.chunkSize, bounds.chunkSize),
    seed: Math.floor(readNumber(root, 'seed', DEFAULT_SETTINGS.seed, bounds.seed)),
    timing: {
      speedMode: readEnum(timing, 'speedMode', SPEED_MODES, DEFAULT_SETTINGS.timing.speedMode),
      cps: readNumber(timing, 'cps', DEFAULT_SETTINGS.timing.cps, bounds.cps),
      wpm: readNumber(timing, 'wpm', DEFAULT_SETTINGS.timing.wpm, bounds.wpm),
      baseIntervalMs: readNumber(
        timing,
        'baseIntervalMs',
        DEFAULT_SETTINGS.timing.baseIntervalMs,
        bounds.baseIntervalMs
      ),
      jitterMs: readNumber(timing, 'jitterMs', DEFAULT_SETTINGS.timing.jitterMs, bounds.jitterMs),
      distribution: readEnum(
        timing,
        'distribution',
        DISTRIBUTIONS,
        DEFAULT_SETTINGS.timing.distribution
      ),
      wordPauseMs: readNumber(
        timing,
        'wordPauseMs',
        DEFAULT_SETTINGS.timing.wordPauseMs,
        bounds.wordPauseMs
      ),
      punctuationPauseMs: readNumber(
        timing,
        'punctuationPauseMs',
        DEFAULT_SETTINGS.timing.punctuationPauseMs,
        bounds.punctuationPauseMs
      ),
      newlinePauseMs: readNumber(
        timing,
        'newlinePauseMs',
        DEFAULT_SETTINGS.timing.newlinePauseMs,
        bounds.newlinePauseMs
      ),
      paragraphPauseMs: readNumber(
        timing,
        'paragraphPauseMs',
        DEFAULT_SETTINGS.timing.paragraphPauseMs,
        bounds.paragraphPauseMs
      ),
      burstSize: readNumber(
        timing,
        'burstSize',
        DEFAULT_SETTINGS.timing.burstSize,
        bounds.burstSize
      ),
      burstPauseMs: readNumber(
        timing,
        'burstPauseMs',
        DEFAULT_SETTINGS.timing.burstPauseMs,
        bounds.burstPauseMs
      )
    },
    typo: {
      rate: readNumber(typo, 'rate', DEFAULT_SETTINGS.typo.rate, bounds.typoRate),
      style: readEnum(typo, 'style', TYPO_STYLES, DEFAULT_SETTINGS.typo.style),
      correction: readEnum(typo, 'correction', TYPO_CORRECTIONS, DEFAULT_SETTINGS.typo.correction)
    },
    keyboard: {
      layout,
      forceUnicodeForAll: readBool(
        keyboard,
        'forceUnicodeForAll',
        DEFAULT_SETTINGS.keyboard.forceUnicodeForAll
      )
    },
    focusGuard: readEnum(root, 'focusGuard', FOCUS_MODES, DEFAULT_SETTINGS.focusGuard),
    hotkeys: {
      stop: normalizeAccelerator(readString(hotkeys, 'stop', DEFAULT_SETTINGS.hotkeys.stop)),
      togglePause: normalizeAccelerator(
        readString(hotkeys, 'togglePause', DEFAULT_SETTINGS.hotkeys.togglePause)
      )
    },
    privacy: {
      persistContent: readBool(privacy, 'persistContent', DEFAULT_SETTINGS.privacy.persistContent),
      persistSettings: readBool(
        privacy,
        'persistSettings',
        DEFAULT_SETTINGS.privacy.persistSettings
      )
    },
    clipboard: {
      restore: readBool(clipboard, 'restore', DEFAULT_SETTINGS.clipboard.restore),
      importCharset: readEnum(
        clipboard,
        'importCharset',
        CHARSETS,
        DEFAULT_SETTINGS.clipboard.importCharset
      )
    },
    update: {
      checkOnStartup: readBool(update, 'checkOnStartup', DEFAULT_SETTINGS.update.checkOnStartup)
    },
    transfer: {
      encoding: readEnum(
        transfer,
        'encoding',
        TRANSFER_ENCODING_VALUES,
        DEFAULT_SETTINGS.transfer.encoding
      ),
      chunkBytes: readNumber(
        transfer,
        'chunkBytes',
        DEFAULT_SETTINGS.transfer.chunkBytes,
        bounds.chunkBytes
      ),
      maxFrameChars: readNumber(
        transfer,
        'maxFrameChars',
        DEFAULT_SETTINGS.transfer.maxFrameChars,
        bounds.maxFrameChars
      ),
      interFrameDelayMs: readNumber(
        transfer,
        'interFrameDelayMs',
        DEFAULT_SETTINGS.transfer.interFrameDelayMs,
        TRANSFER_LIMITS.interFrameDelayMs
      ),
      pasteFrameIncludesNewline: readBool(
        transfer,
        'pasteFrameIncludesNewline',
        DEFAULT_SETTINGS.transfer.pasteFrameIncludesNewline
      )
    },
    verifyStuckKeys: readBool(root, 'verifyStuckKeys', DEFAULT_SETTINGS.verifyStuckKeys),
    logLevel: readEnum(root, 'logLevel', LOG_LEVELS, DEFAULT_SETTINGS.logLevel)
  }
}

/**
 * @description 深合并设置补丁（嵌套分组逐层合并），供设置界面局部更新
 * @param base 当前设置
 * @param patch 局部补丁
 * @returns 合并并归一化后的设置
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const patchRecord = asRecord(patch)
  const merged = {
    ...base,
    ...patchRecord,
    timing: { ...base.timing, ...asRecord(patchRecord.timing) },
    typo: { ...base.typo, ...asRecord(patchRecord.typo) },
    keyboard: { ...base.keyboard, ...asRecord(patchRecord.keyboard) },
    hotkeys: { ...base.hotkeys, ...asRecord(patchRecord.hotkeys) },
    privacy: { ...base.privacy, ...asRecord(patchRecord.privacy) },
    clipboard: { ...base.clipboard, ...asRecord(patchRecord.clipboard) },
    update: { ...base.update, ...asRecord(patchRecord.update) }
  }
  return normalizeSettings(merged)
}

/**
 * @description 从完整设置里挑出引擎真正需要的字段
 * @param settings 完整设置
 * @returns 引擎设置
 */
export function toEngineSettings(settings: Settings): EngineSettings {
  return {
    startDelayMs: settings.startDelayMs,
    insertMode: settings.insertMode,
    autoPasteThreshold: settings.autoPasteThreshold,
    chunkSize: settings.chunkSize,
    layout: settings.keyboard.layout,
    forceUnicodeForAll: settings.keyboard.forceUnicodeForAll,
    focusGuard: settings.focusGuard,
    seed: settings.seed,
    verifyStuckKeys: settings.verifyStuckKeys,
    interFrameDelayMs: settings.transfer.interFrameDelayMs,
    pasteFrameIncludesNewline: settings.transfer.pasteFrameIncludesNewline,
    timing: settings.timing,
    typo: {
      rate: settings.typo.rate,
      style: settings.typo.style,
      correction: settings.typo.correction
    }
  }
}

export type { BoundsKey }
