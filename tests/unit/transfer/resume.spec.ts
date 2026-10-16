import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildResumeToken } from '@main/util/frame'
import { prepareTransfer, type PreparedTransfer } from '@main/transfer/prepare'
import {
  describeIndexes,
  matchResume,
  parseResumeState,
  resolveSendIndexes
} from '@main/transfer/resume'
import type { ResumeState } from '@shared/transfer/transfer'

let work: string
let job: PreparedTransfer

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'typer-resume-'))
  const path = join(work, 'src.bin')
  writeFileSync(path, Buffer.from('0123456789'.repeat(205)))
  job = await prepareTransfer({
    path,
    options: { encoding: 'hex', chunkBytes: 256, maxFrameChars: 4096 }
  })
})

afterEach(async () => {
  await job.dispose()
  rmSync(work, { recursive: true, force: true })
})

/**
 * @description 造一份与当前任务匹配的接收端报告
 * @param overrides 需要覆盖的报告字段
 * @returns 报告 JSON 文本
 */
function report(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    reportVersion: 1,
    job: job.summary.job,
    total: job.summary.total,
    size: job.summary.size,
    sha256: job.summary.sha256,
    enc: 'hex',
    chunk: 256,
    missing: '3,5-7',
    doneRanges: '0-2,4,8-',
    ...overrides
  })
}

describe('parseResumeState', () => {
  it('解析接收端报告（优先用 missing 字段）', () => {
    const state = parseResumeState(report())
    expect(state.source).toBe('report')
    expect(state.job).toBe(job.summary.job)
    expect(state.total).toBe(job.summary.total)
    expect(state.size).toBe(job.summary.size)
    expect(state.sha256).toBe(job.summary.sha256)
    expect(state.missing).toEqual([3, 5, 6, 7])
  })

  it('只有 doneRanges 时反推缺失片', () => {
    const state = parseResumeState(report({ missing: '', doneRanges: '0-5' }))
    expect(state.missing).toEqual([6, 7, 8])
  })

  it('解析续传令牌（令牌里没有大小与哈希）', () => {
    const token = buildResumeToken({
      job: job.summary.job,
      total: job.summary.total,
      missing: [2, 4]
    })
    const state = parseResumeState(token)
    expect(state.source).toBe('token')
    expect(state.missing).toEqual([2, 4])
    expect(state.sha256).toBeNull()
    expect(state.size).toBe(-1)
  })

  it('解析裸片号列表（操作者手抄 #MISS 的情况）', () => {
    const state = parseResumeState('3, 7-9')
    expect(state.source).toBe('ranges')
    expect(state.missing).toEqual([3, 7, 8, 9])
  })

  it('非法输入给出可读错误', () => {
    expect(() => parseResumeState('   ')).toThrow(/为空/)
    expect(() => parseResumeState('{ 不是 json')).toThrow(/JSON/)
    expect(() => parseResumeState('{"total":3}')).toThrow(/job/)
    expect(() => parseResumeState('abc-def')).toThrow(/无法识别/)
    expect(() => parseResumeState(buildResumeToken({ job: 'a', total: 1, missing: [] }))).toThrow()
  })
})

describe('matchResume', () => {
  /**
   * @description 造一份与当前任务匹配的续传状态
   * @param overrides 需要覆盖的状态字段
   * @returns 续传状态
   */
  const state = (overrides: Partial<ResumeState> = {}): ResumeState => ({
    job: job.summary.job,
    total: job.summary.total,
    size: job.summary.size,
    sha256: job.summary.sha256,
    doneRanges: '',
    missing: [1, 2],
    source: 'report',
    ...overrides
  })

  it('任务一致时给出缺失片并保持升序', () => {
    const match = matchResume(state({ missing: [5, 1, 3, 1] }), job.summary)
    expect(match.missing).toEqual([1, 3, 5])
    expect(match.warnings).toEqual([])
  })

  it('任务身份任何一项不一致都拒绝（避免把两次任务混在一起）', () => {
    expect(() => matchResume(state({ job: 'deadbeef' }), job.summary)).toThrow(/另一次任务/)
    expect(() => matchResume(state({ total: 99 }), job.summary)).toThrow(/片总数不一致/)
    expect(() => matchResume(state({ size: 1 }), job.summary)).toThrow(/文件大小不一致/)
    expect(() => matchResume(state({ sha256: 'f'.repeat(64) }), job.summary)).toThrow(
      /整文件哈希不一致/
    )
  })

  it('没有哈希时只给警告（令牌场景）', () => {
    const match = matchResume(state({ sha256: null }), job.summary)
    expect(match.warnings.join()).toMatch(/没有整文件哈希/)
  })

  it('缺失片为空时给出"看起来已收全"的提示', () => {
    const match = matchResume(state({ missing: [] }), job.summary)
    expect(match.missing).toEqual([])
    expect(match.warnings.join()).toMatch(/收全/)
  })

  it('手抄片号超出当前任务片数时拒绝（说明片大小设置与上次不同）', () => {
    const ranges = state({
      source: 'ranges',
      job: '',
      total: -1,
      size: -1,
      sha256: null,
      missing: [0, 99]
    })
    expect(() => matchResume(ranges, job.summary)).toThrow(/超出当前任务的片数范围/)
  })

  it('已知规模时越界片号在解析阶段就被拒绝', () => {
    expect(() => parseResumeState(report({ missing: '999' }))).toThrow(/超出总数/)
  })
})

describe('resolveSendIndexes', () => {
  it('默认全发，from 从指定片开始，only 优先', () => {
    expect(resolveSendIndexes(3)).toEqual([0, 1, 2])
    expect(resolveSendIndexes(3, { from: 1 })).toEqual([1, 2])
    expect(resolveSendIndexes(5, { from: 4, only: '0,2-3' })).toEqual([0, 2, 3])
    expect(resolveSendIndexes(3, { from: 3 })).toEqual([])
  })

  it('非法片号转成可读错误', () => {
    expect(() => resolveSendIndexes(3, { from: 9 })).toThrow(/起始片号不合法/)
    expect(() => resolveSendIndexes(3, { only: '5' })).toThrow(/超出总数/)
    expect(() => resolveSendIndexes(3, { only: 'x' })).toThrow(/无法解析/)
  })
})

describe('describeIndexes', () => {
  it('合并成紧凑区间，便于展示与复制', () => {
    expect(describeIndexes([1, 2, 3, 7], 10)).toBe('1-3,7')
    expect(describeIndexes([], 10)).toBe('无')
  })
})
