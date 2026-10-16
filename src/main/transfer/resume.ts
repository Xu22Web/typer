import {
  FrameError,
  formatIndexList,
  isFrameLine,
  parseFrame,
  parseIndexList,
  resolveIndexes
} from '@tools/lib/frame.mjs'

import { TransferError } from './prepare'
import type { ResumeMatch, ResumeState, TransferJobSummary } from '@shared/transfer/transfer'

/**
 * @description 解析操作者从接收端带回来的续传状态；接受 resume.json、续传令牌或裸片号列表，只认"片号集合"这一种语义
 * @param raw 续传文本（报告 / 令牌 / 片号列表）
 * @returns 续传状态
 */
export function parseResumeState(raw: string): ResumeState {
  const text = String(raw ?? '').trim()
  if (text.length === 0) throw new TransferError('resume-format', '续传状态为空')

  if (isFrameLine(text)) return parseToken(text)
  if (text.startsWith('{')) return parseReport(text)
  return parseRanges(text)
}

/**
 * @description 解析续传令牌（`@TYPER1/R …`）
 * @param text 令牌文本
 * @returns 续传状态
 */
function parseToken(text: string): ResumeState {
  let frame
  try {
    frame = parseFrame(text.trim())
  } catch (error) {
    throw new TransferError(
      'resume-format',
      `续传令牌格式不正确：${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (frame.kind !== 'resume') {
    throw new TransferError('resume-format', '续传令牌应以 @TYPER1/R 开头')
  }
  return {
    job: frame.job,
    total: frame.total,
    size: -1,
    sha256: null,
    doneRanges: '',
    missing: frame.missing,
    source: 'token'
  }
}

/**
 * @description 解析接收端持续写出的 JSON 报告
 * @param text 报告文本
 * @returns 续传状态
 */
function parseReport(text: string): ResumeState {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TransferError('resume-format', '续传报告不是合法的 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TransferError('resume-format', '续传报告应为 JSON 对象')
  }

  const record = parsed as Record<string, unknown>
  const job = typeof record.job === 'string' ? record.job : ''
  if (!/^[0-9a-f]{4,16}$/.test(job))
    throw new TransferError('resume-format', '续传报告缺少合法的 job')

  const total = readInt(record.total, 'total')
  const size = record.size === undefined ? -1 : readInt(record.size, 'size')
  const sha256 =
    typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256) ? record.sha256 : null
  const doneRanges = typeof record.doneRanges === 'string' ? record.doneRanges : ''

  let missing: number[]
  try {
    if (typeof record.missing === 'string' && record.missing.length > 0) {
      missing = parseIndexList(record.missing, total)
    } else if (doneRanges.length > 0) {
      const done = new Set(parseIndexList(doneRanges, total))
      missing = []
      for (let index = 0; index < total; index++) if (!done.has(index)) missing.push(index)
    } else {
      missing = []
    }
  } catch (error) {
    throw new TransferError(
      'resume-format',
      `续传报告里的片号无法解析：${error instanceof Error ? error.message : String(error)}`
    )
  }

  return { job, total, size, sha256, doneRanges, missing, source: 'report' }
}

/**
 * @description 解析裸片号列表（操作者手抄 `#MISS` 那一行）
 * @param text 片号列表文本
 * @returns 续传状态（无 job/total 信息）
 */
function parseRanges(text: string): ResumeState {
  // 手抄 `#MISS` 的情况：只有片号列表，没有 job/total
  try {
    return {
      job: '',
      total: -1,
      size: -1,
      sha256: null,
      doneRanges: '',
      missing: parseIndexList(text, undefined),
      source: 'ranges'
    }
  } catch (error) {
    throw new TransferError(
      'resume-format',
      `无法识别续传状态：${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * @description 读取报告里的非负整数字段
 * @param value 候选值
 * @param name 字段名，用于拼错误消息
 * @returns 合法的非负整数
 */
function readInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TransferError('resume-format', `续传报告里的 ${name} 不合法`)
  }
  return value
}

/**
 * @description 把续传状态与当前任务比对；任何任务身份不一致（job / 片数 / 大小 / 哈希）都直接拒绝，避免把两次任务的数据混进同一个文件
 * @param state 续传状态
 * @param summary 当前任务摘要
 * @returns 匹配结果：待补发的片与提示
 */
export function matchResume(state: ResumeState, summary: TransferJobSummary): ResumeMatch {
  const warnings: string[] = []

  if (state.job.length > 0 && state.job !== summary.job) {
    throw new TransferError(
      'resume-mismatch',
      `续传状态属于另一次任务（${state.job}），当前任务是 ${summary.job}。请确认续传状态与所选文件是同一批`
    )
  }
  if (state.total >= 0 && state.total !== summary.total) {
    throw new TransferError(
      'resume-mismatch',
      `片总数不一致：续传状态是 ${state.total} 片，当前任务是 ${summary.total} 片。请检查片大小设置是否与上次一致`
    )
  }
  if (state.size >= 0 && state.size !== summary.size) {
    throw new TransferError(
      'resume-mismatch',
      `文件大小不一致：续传状态是 ${state.size} 字节，当前文件是 ${summary.size} 字节`
    )
  }
  if (state.sha256 !== null && state.sha256 !== summary.sha256) {
    throw new TransferError(
      'resume-mismatch',
      '整文件哈希不一致：续传状态对应的不是当前文件（文件可能已被修改）'
    )
  }
  if (state.sha256 === null) {
    warnings.push('续传状态里没有整文件哈希，仅按片号续传（接收端仍会做逐片与最终校验）')
  }
  if (state.source === 'ranges' && state.missing.some((index) => index >= summary.total)) {
    throw new TransferError('resume-mismatch', '续传状态里的片号超出当前任务的片数范围')
  }

  const missing = [
    ...new Set(state.missing.filter((index) => index >= 0 && index < summary.total))
  ].sort((a, b) => a - b)
  if (missing.length === 0) {
    warnings.push('没有缺失的片：接收端看起来已经收全，可以直接让它合并校验')
  }

  return { state, missing, warnings }
}

export interface ResolveSendOptions {
  /** 只发指定的片（`3,5,12-20`） */
  only?: string
  /** 从第几片开始（0 基） */
  from?: number
}

/**
 * @description 计算这次实际要发送的片号：显式 only 优先，否则从 from 起，最后退化为全发
 * @param total 任务总片数
 * @param options 片选择条件
 * @returns 升序片号列表
 */
export function resolveSendIndexes(total: number, options: ResolveSendOptions = {}): number[] {
  try {
    return resolveIndexes(total, { from: options.from ?? 0, only: options.only ?? '' })
  } catch (error) {
    if (error instanceof FrameError) throw new TransferError('range', error.message)
    throw error
  }
}

/**
 * @description 把片号集合压成紧凑区间文本（给界面展示用）
 * @param indexes 片号列表
 * @param total 任务总片数
 * @returns 区间文本
 */
export function describeIndexes(indexes: readonly number[], total: number): string {
  if (indexes.length === 0) return '无'
  try {
    return formatIndexList([...indexes], total)
  } catch {
    return `${indexes.length} 片`
  }
}
