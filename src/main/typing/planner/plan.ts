import {
  BACKSPACE_ACTION,
  pickTypoChar,
  shouldMakeTypo,
  type TypoOptions
} from '../scheduling/typo'
import {
  DEFAULT_LAYOUT_ID,
  VK,
  getLayout,
  lookupLayoutKey,
  type KeyboardLayout,
  type LayoutId
} from './keymap'
import { isCjk, normalizeText, toCodePoints } from './text'
import type { KeyAction, KeystrokeAction, PlanStats, TypingPlan } from './types'

export interface PlanOptions {
  /** 目标窗口使用的键盘布局（决定"真实按键"如何映射） */
  layout?: LayoutId | string
  /** 造错设置；`null` / 省略表示不打错 */
  typo?: TypoOptions | null
}

export type CharResolution =
  { kind: 'key'; action: KeyAction } | { kind: 'unsupported'; char: string }

export const NEWLINE_ACTION: KeyAction = {
  kind: 'key',
  vk: VK.ENTER,
  modifiers: [],
  char: '\n'
}

export const TAB_ACTION: KeyAction = { kind: 'key', vk: VK.TAB, modifiers: [], char: '\t' }

/**
 * @description 单字符 → 真实按键；没有物理键位的字符（中文、emoji 等）返回 unsupported
 * @param char 单个码点
 * @param layout 目标窗口使用的键盘布局
 * @returns 真实按键动作，或"无法输入"
 */
export function resolveChar(char: string, layout: KeyboardLayout): CharResolution {
  if (char === '\n') return { kind: 'key', action: NEWLINE_ACTION }
  if (char === '\t') return { kind: 'key', action: TAB_ACTION }

  const key = lookupLayoutKey(layout, char)
  if (!key) return { kind: 'unsupported', char }

  return {
    kind: 'key',
    action: { kind: 'key', vk: key.vk, modifiers: [...key.modifiers], char }
  }
}

interface PlanCollector {
  typed: number
  unsupported: Record<string, number>
  typos: number
}

interface IterateContext {
  layout: KeyboardLayout
  typo: TypoOptions | null
  collector?: PlanCollector
}

/**
 * @description 产出单个字符对应的动作，并按需累计统计
 * @param char 单个码点
 * @param context 布局、造错与统计上下文
 * @param options 是否把该字符计入"新输入"统计（造错产生的字符不计入）
 * @returns 动作生成器
 */
function* emitChar(
  char: string,
  context: IterateContext,
  options: { countStats: boolean }
): Generator<KeystrokeAction> {
  const resolution = resolveChar(char, context.layout)
  const collector = context.collector

  if (resolution.kind === 'unsupported') {
    if (collector && options.countStats) {
      collector.unsupported[char] = (collector.unsupported[char] ?? 0) + 1
    }
    return
  }

  if (collector) collector.typed += 1
  yield resolution.action
}

/**
 * @description 统计字符串的码点数（代理对记为 1）
 * @param text 待统计文本
 * @returns 码点个数
 */
function countCodePoints(text: string): number {
  return toCodePoints(text).length
}

/**
 * @description 判断字符是否可参与"相邻字符颠倒"式造错（当前只针对拉丁字母）
 * @param char 单个码点
 * @returns 是否可颠倒
 */
function isTransposable(char: string): boolean {
  return /^[a-zA-Z]$/.test(char)
}

/**
 * @description 逐码点产出动作，并在此处施加造错与纠错逻辑
 * @param codes 码点序列
 * @param context 布局、造错与统计上下文
 * @returns 动作生成器
 */
function* iterateCodes(codes: string[], context: IterateContext): Generator<KeystrokeAction> {
  const typo = context.typo

  for (let index = 0; index < codes.length; index++) {
    const char = codes[index] as string
    const next = codes[index + 1]

    // 相邻字符颠倒：打错 -> 退格 -> 重打（correction = none 时保留颠倒结果）
    if (
      typo &&
      typo.style === 'transpose' &&
      typo.rate > 0 &&
      next !== undefined &&
      isTransposable(char) &&
      isTransposable(next) &&
      shouldMakeTypo(typo)
    ) {
      yield* emitChar(next, context, { countStats: false })
      yield* emitChar(char, context, { countStats: false })
      if (context.collector) context.collector.typos += 1

      if (typo.correction === 'auto') {
        for (let back = 0; back < 2; back++) {
          if (context.collector) context.collector.typed += 1
          yield BACKSPACE_ACTION
        }
        yield* emitChar(char, context, { countStats: false })
        yield* emitChar(next, context, { countStats: false })
      }
      // correction = none：保留颠倒结果，不再重打
      index += 1
      continue
    }

    const wrong =
      typo && typo.rate > 0 && typo.style !== 'transpose' && shouldMakeTypo(typo)
        ? pickTypoChar(char, typo.style, typo.rng)
        : null

    if (wrong && wrong !== char) {
      if (context.collector) context.collector.typos += 1
      yield* emitChar(wrong, context, { countStats: false })

      if (typo?.correction === 'auto') {
        const backspaces = countCodePoints(wrong)
        for (let back = 0; back < backspaces; back++) {
          if (context.collector) context.collector.typed += 1
          yield BACKSPACE_ACTION
        }
        yield* emitChar(char, context, { countStats: true })
      }
      // correction = none：保留错字，不输入正确字符
      continue
    }

    yield* emitChar(char, context, { countStats: true })
  }
}

/**
 * @description 流式产出动作：不保存整个动作数组，长文本也只占常数内存；启用造错时，
 * 调用方必须为"计数"与"产出"两次遍历提供同种子、同起点的独立 Rng，否则总数与实际动作数会不一致
 * @param input 原始文本
 * @param options 布局与造错设置
 * @returns 动作生成器
 */
export function* iterateActions(
  input: string,
  options: PlanOptions = {}
): Generator<KeystrokeAction> {
  const { text } = normalizeText(input)
  yield* iterateCodes(toCodePoints(text), {
    layout: getLayout(options.layout),
    typo: options.typo ?? null
  })
}

/**
 * @description 一次性构建完整计划（保留动作）并汇总统计，供预览与自检使用
 * @param input 原始文本
 * @param options 布局与造错设置
 * @returns 动作列表与统计
 */
export function buildPlan(input: string, options: PlanOptions = {}): TypingPlan {
  const { text, skipped } = normalizeText(input)
  const codes = toCodePoints(text)
  const collector: PlanCollector = {
    typed: 0,
    unsupported: {},
    typos: 0
  }

  const actions = [
    ...iterateCodes(codes, {
      layout: getLayout(options.layout),
      typo: options.typo ?? null,
      collector
    })
  ]

  const stats: PlanStats = {
    chars: codes.length,
    typed: collector.typed,
    cjk: codes.filter((code) => isCjk(code)).length,
    unsupported: collector.unsupported,
    typos: collector.typos,
    skipped
  }

  return { actions, stats }
}

/**
 * @description 只统计动作数（不保留动作），用于进度估算
 * @param input 原始文本
 * @param options 布局与造错设置
 * @returns 动作总数
 */
export function countTypedActions(input: string, options: PlanOptions = {}): number {
  const { text } = normalizeText(input)
  const collector: PlanCollector = {
    typed: 0,
    unsupported: {},
    typos: 0
  }
  const iterator = iterateCodes(toCodePoints(text), {
    layout: getLayout(options.layout),
    typo: options.typo ?? null,
    collector
  })
  while (!iterator.next().done) {
    /* 仅消费，动作不保留 */
  }
  return collector.typed
}

/**
 * @description 去掉没有任何键位可输入的字符（汉字、emoji 等），其余内容原样保留。
 * 文本输入允许"打不出来的部分跳过、其它照常输入"，因此这里只做减法，不做替换
 * ——把中文换成拼音之类的改写会篡改内容，不在自动处理范围内。
 * @param input 原始文本
 * @param layout 目标窗口使用的键盘布局
 * @returns 剩余文本与被丢弃的字符数
 */
export function stripUnsupported(
  input: string,
  layout?: PlanOptions['layout']
): { text: string; dropped: number } {
  const keyboard = getLayout(layout)
  const { text } = normalizeText(input)
  const kept: string[] = []
  let dropped = 0

  for (const char of toCodePoints(text)) {
    if (resolveChar(char, keyboard).kind === 'unsupported') dropped += 1
    else kept.push(char)
  }

  return { text: kept.join(''), dropped }
}

export { DEFAULT_LAYOUT_ID }
