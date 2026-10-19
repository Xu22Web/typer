import type { EngineSettings } from '../typing/engine/TypingEngine'
import type { FocusGuardMode } from '../typing/focus/focusGuard'
import { isLayoutId, type LayoutId } from '../typing/planner/keymap'
import {
  INJECTION_PROFILES,
  PROFILE_LIMITS,
  TRANSFER_PACES,
  type TransferPace
} from '../typing/scheduling/profile'
import type { JitterDistribution, SpeedMode } from '../typing/scheduling/timing'
import type { TypoCorrection, TypoStyle } from '../typing/scheduling/typo'
import {
  TRANSFER_ALPHABETS,
  TRANSFER_COMPRESSIONS,
  TRANSFER_LIMITS,
  TRANSFER_TARGET_MODES,
  type TransferAlphabet,
  type TransferCompression,
  type TransferTargetMode
} from '@shared/transfer/transfer'
import { DEFAULT_PLACEMENT, type DockEdge } from '../window/floatDock'
import type { ImportCharset, LogLevel, Settings } from './types'

export type { ImportCharset, LogLevel, Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  startDelayMs: 3000,
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
  injection: {
    profile: 'normal'
  },
  typo: {
    rate: 0.02,
    style: 'adjacent',
    correction: 'auto'
  },
  keyboard: {
    layout: 'us'
  },
  focusGuard: 'warn',
  hotkeys: {
    stop: 'Ctrl+Alt+X',
    togglePause: 'Ctrl+Alt+P'
  },
  privacy: {
    persistContent: false,
    persistSettings: true
  },
  files: {
    importCharset: 'auto'
  },
  transfer: {
    // 远程桌面只转发真实键盘事件：默认用零 Shift 的 5 位档，避免每个字符都付修饰键间隔
    alphabet: 'ascii32',
    compression: 'auto',
    quality: 9,
    mode: 'term',
    // 默认稳健：控制台输入队列很小，攒批直投偶尔会丢一个字符（帧头 CRC / 片 CRC 能抓到并重传，
    // 但重传本身要花时间）。要更快就显式切到「极速」，用 --stats 观察实际丢片率。
    paceMode: 'safe',
    chunkBytes: 16384,
    maxFrameChars: 65536,
    interFrameDelayMs: 0
  },
  update: {
    checkOnStartup: true
  },
  floating: {
    ...(DEFAULT_PLACEMENT as { mode: 'docked'; edge: DockEdge; offset: number }),
    x: 0,
    y: 0
  },
  verifyStuckKeys: true,
  logLevel: 'info'
}

/** 每个数值字段的合法区间与默认值，用于“夹取”非法输入。 */
export const NUMERIC_BOUNDS = {
  startDelayMs: [0, 60_000],
  // 每批动作数与字符/秒的可选区间随注入档位变化，这里给的是标准档（normal）的区间；
  // 归一化时按实际档位从 PROFILE_LIMITS 取值
  chunkSize: PROFILE_LIMITS.normal.chunkSize,
  seed: [0, 0xffffffff],
  cps: PROFILE_LIMITS.normal.cps,
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
  chunkBytes: TRANSFER_LIMITS.chunkBytes,
  maxFrameChars: TRANSFER_LIMITS.maxFrameChars,
  quality: TRANSFER_LIMITS.quality,
  // 浮窗沿边位置与自由浮动坐标都只是屏幕坐标，真正的夹取由 floatDock 按所在显示器完成；
  // 这里只挡掉明显非法的值
  floatOffset: [-100_000, 100_000],
  floatCoord: [-100_000, 100_000]
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
 * @description 把未知值收窄成普通对象（非对象时给空对象）
 * @param value 候选值
 * @returns 普通对象
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

const SPEED_MODES: readonly SpeedMode[] = ['cps', 'wpm', 'interval', 'max']
const DISTRIBUTIONS: readonly JitterDistribution[] = ['uniform', 'gaussian']
const TYPO_STYLES: readonly TypoStyle[] = ['adjacent', 'lookalike', 'transpose']
const TYPO_CORRECTIONS: readonly TypoCorrection[] = ['auto', 'none']
const FOCUS_MODES: readonly FocusGuardMode[] = ['off', 'warn', 'strict']
const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug']
const CHARSETS: readonly ImportCharset[] = ['auto', 'utf8', 'utf16le', 'gbk']
const TRANSFER_ALPHABET_VALUES: readonly TransferAlphabet[] = TRANSFER_ALPHABETS
const TRANSFER_COMPRESSION_VALUES: readonly TransferCompression[] = TRANSFER_COMPRESSIONS
const TRANSFER_MODE_VALUES: readonly TransferTargetMode[] = TRANSFER_TARGET_MODES
const DOCK_EDGES: readonly DockEdge[] = ['left', 'right', 'top', 'bottom']
const FLOAT_MODES = ['docked', 'floating'] as const

/**
 * @description 把任意（被手工编辑过的）JSON 归一化为合法设置；类型错误回退默认值、超范围夹取、未知字段丢弃，且永不抛错
 * @param raw 原始 JSON 值
 * @returns 完整的合法设置
 */
export function normalizeSettings(raw: unknown): Settings {
  const root = asRecord(raw)
  const timing = asRecord(root.timing)
  const injection = asRecord(root.injection)
  const typo = asRecord(root.typo)
  const keyboard = asRecord(root.keyboard)
  const hotkeys = asRecord(root.hotkeys)
  const privacy = asRecord(root.privacy)
  const files = asRecord(root.files)
  const update = asRecord(root.update)
  const transfer = asRecord(root.transfer)
  const floating = asRecord(root.floating)
  const bounds = NUMERIC_BOUNDS

  const profile = readEnum(
    injection,
    'profile',
    INJECTION_PROFILES,
    DEFAULT_SETTINGS.injection.profile
  )
  const limits = PROFILE_LIMITS[profile]
  // "不限速"只属于极速档：旧配置或被手改的文件在标准档下退回字符/秒
  const requestedSpeed = readEnum(
    timing,
    'speedMode',
    SPEED_MODES,
    DEFAULT_SETTINGS.timing.speedMode
  )
  const speedMode: SpeedMode =
    requestedSpeed === 'max' && profile !== 'turbo' ? 'cps' : requestedSpeed
  const paceMode: TransferPace = readEnum(
    transfer,
    'paceMode',
    TRANSFER_PACES,
    DEFAULT_SETTINGS.transfer.paceMode
  )

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
    chunkSize: readNumber(root, 'chunkSize', DEFAULT_SETTINGS.chunkSize, limits.chunkSize),
    seed: Math.floor(readNumber(root, 'seed', DEFAULT_SETTINGS.seed, bounds.seed)),
    injection: { profile },
    timing: {
      speedMode,
      cps: readNumber(timing, 'cps', DEFAULT_SETTINGS.timing.cps, limits.cps),
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
      layout
    },
    focusGuard: readEnum(root, 'focusGuard', FOCUS_MODES, DEFAULT_SETTINGS.focusGuard),
    hotkeys: {
      stop: readString(hotkeys, 'stop', DEFAULT_SETTINGS.hotkeys.stop),
      togglePause: readString(hotkeys, 'togglePause', DEFAULT_SETTINGS.hotkeys.togglePause)
    },
    privacy: {
      persistContent: readBool(privacy, 'persistContent', DEFAULT_SETTINGS.privacy.persistContent),
      persistSettings: readBool(
        privacy,
        'persistSettings',
        DEFAULT_SETTINGS.privacy.persistSettings
      )
    },
    files: {
      importCharset: readEnum(
        files,
        'importCharset',
        CHARSETS,
        DEFAULT_SETTINGS.files.importCharset
      )
    },
    update: {
      checkOnStartup: readBool(update, 'checkOnStartup', DEFAULT_SETTINGS.update.checkOnStartup)
    },
    transfer: {
      alphabet: readEnum(
        transfer,
        'alphabet',
        TRANSFER_ALPHABET_VALUES,
        DEFAULT_SETTINGS.transfer.alphabet
      ),
      compression: readEnum(
        transfer,
        'compression',
        TRANSFER_COMPRESSION_VALUES,
        DEFAULT_SETTINGS.transfer.compression
      ),
      quality: Math.round(
        readNumber(transfer, 'quality', DEFAULT_SETTINGS.transfer.quality, bounds.quality)
      ),
      mode: readEnum(transfer, 'mode', TRANSFER_MODE_VALUES, DEFAULT_SETTINGS.transfer.mode),
      paceMode,
      chunkBytes: Math.round(
        readNumber(transfer, 'chunkBytes', DEFAULT_SETTINGS.transfer.chunkBytes, bounds.chunkBytes)
      ),
      maxFrameChars: Math.round(
        readNumber(
          transfer,
          'maxFrameChars',
          DEFAULT_SETTINGS.transfer.maxFrameChars,
          bounds.maxFrameChars
        )
      ),
      interFrameDelayMs: readNumber(
        transfer,
        'interFrameDelayMs',
        DEFAULT_SETTINGS.transfer.interFrameDelayMs,
        TRANSFER_LIMITS.interFrameDelayMs
      )
    },
    verifyStuckKeys: readBool(root, 'verifyStuckKeys', DEFAULT_SETTINGS.verifyStuckKeys),
    logLevel: readEnum(root, 'logLevel', LOG_LEVELS, DEFAULT_SETTINGS.logLevel),
    floating: {
      mode: readEnum(floating, 'mode', FLOAT_MODES, DEFAULT_SETTINGS.floating.mode),
      edge: readEnum(floating, 'edge', DOCK_EDGES, DEFAULT_SETTINGS.floating.edge),
      offset: readNumber(floating, 'offset', DEFAULT_SETTINGS.floating.offset, bounds.floatOffset),
      x: readNumber(floating, 'x', DEFAULT_SETTINGS.floating.x, bounds.floatCoord),
      y: readNumber(floating, 'y', DEFAULT_SETTINGS.floating.y, bounds.floatCoord)
    }
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
    injection: { ...base.injection, ...asRecord(patchRecord.injection) },
    typo: { ...base.typo, ...asRecord(patchRecord.typo) },
    keyboard: { ...base.keyboard, ...asRecord(patchRecord.keyboard) },
    hotkeys: { ...base.hotkeys, ...asRecord(patchRecord.hotkeys) },
    privacy: { ...base.privacy, ...asRecord(patchRecord.privacy) },
    files: { ...base.files, ...asRecord(patchRecord.files) },
    transfer: { ...base.transfer, ...asRecord(patchRecord.transfer) },
    update: { ...base.update, ...asRecord(patchRecord.update) },
    floating: { ...base.floating, ...asRecord(patchRecord.floating) }
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
    chunkSize: settings.chunkSize,
    layout: settings.keyboard.layout,
    focusGuard: settings.focusGuard,
    seed: settings.seed,
    verifyStuckKeys: settings.verifyStuckKeys,
    profile: settings.injection.profile,
    transferPace: settings.transfer.paceMode,
    interFrameDelayMs: settings.transfer.interFrameDelayMs,
    timing: settings.timing,
    typo: {
      rate: settings.typo.rate,
      style: settings.typo.style,
      correction: settings.typo.correction
    }
  }
}

export type { BoundsKey }
