import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TransferError, prepareTransfer, type PreparedTransfer } from './prepare'
import { describeIndexes, matchResume, parseResumeState, resolveSendIndexes } from './resume'
import type { TypingRequest } from '../typing/engine/TypingEngine'
import type {
  ResumeMatch,
  TransferJobSummary,
  TransferPrepareOptions,
  TransferPrepareProgress
} from '@shared/transfer/transfer'

export interface TransferSessionDeps {
  onPrepareProgress?: (progress: TransferPrepareProgress) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface StartFramesOptions {
  /** 只发这些片（`3,5,12-20`）；空表示按 from 决定 */
  only?: string
  /** 从第几片开始（0 基） */
  from?: number
  /**
   * 接收端还缺哪些片（来自续传状态）；`null` / 省略表示"全新传输"。
   *
   * 由它来决定是否携带开始帧与结束帧：
   * - 全新传输：两者都带（接收端据此建立任务并知道何时可以合并）
   * - 续传补发：只有在这批片能把接收端补齐时才带结束帧，否则接收端会立刻报 #MISS
   */
  resumeMissing?: number[] | null
  /** 显式覆盖开始/结束帧的发送（测试与高级用法） */
  sendBegin?: boolean
  sendEnd?: boolean
}

export interface FramePlan {
  indexes: number[]
  ranges: string
  sendBegin: boolean
  sendEnd: boolean
}

/**
 * 当前文件传输任务的持有者。
 *
 * 为什么要有"当前任务"这个概念：帧是**按需渲染**的（一片从磁盘读一次），
 * 所以准备阶段得到的句柄与分片表必须活着，直到用户点"开始输入"甚至续传补发。
 */
export class TransferSession {
  private current: PreparedTransfer | null = null
  private preparing = false
  private canceled = false

  constructor(private readonly deps: TransferSessionDeps = {}) {}

  get summary(): TransferJobSummary | null {
    return this.current?.summary ?? null
  }

  get isPreparing(): boolean {
    return this.preparing
  }

  /** 准备任务（会替换掉上一个任务：同时只保留一份，避免句柄泄漏）。 */
  async prepare(
    path: string,
    options: TransferPrepareOptions,
    config: { reuse?: boolean } = {}
  ): Promise<TransferJobSummary> {
    if (this.preparing) throw new TransferError('busy', '已有文件正在准备，请稍候')
    this.preparing = true
    this.canceled = false

    // 同一个文件、只是改了片大小/编码时复用哈希（避免把 GB 级文件重新读一遍）
    const previousJob = this.current
    const cached =
      config.reuse === true && previousJob && previousJob.summary.path === path
        ? { sha256: previousJob.summary.sha256, ...previousJob.stamp }
        : undefined

    try {
      const next = await prepareTransfer({
        path,
        options,
        cached,
        deps: {
          onProgress: this.deps.onPrepareProgress,
          shouldCancel: () => this.canceled
        }
      })

      const previous = this.current
      this.current = next
      if (previous) await previous.dispose()
      return next.summary
    } finally {
      this.preparing = false
    }
  }

  /** 中止正在进行的准备（读取/哈希阶段会尽快退出）。 */
  cancelPrepare(): void {
    this.canceled = true
  }

  /** 解析并比对操作者带回来的续传状态。 */
  matchResume(text: string): ResumeMatch {
    return matchResume(parseResumeState(text), this.requireJob().summary)
  }

  /** 本次要发送的片与是否携带开始/结束帧。 */
  plan(options: StartFramesOptions = {}): FramePlan {
    const job = this.requireJob()
    const total = job.summary.total
    const indexes = resolveSendIndexes(total, { only: options.only, from: options.from ?? 0 })

    const missing = options.resumeMissing ?? null
    const hasResume = missing !== null && missing.length > 0
    const sent = new Set(indexes)
    const coversMissing = hasResume && missing.every((index) => sent.has(index))

    return {
      indexes,
      ranges: describeIndexes(indexes, total),
      // 没有续传信息时一律带开始帧：接收端可能没有 meta.json，缺了它就只能报错
      sendBegin: options.sendBegin ?? (!hasResume || indexes.length === total),
      // 只有"这次发完接收端就齐了"才发结束帧（全量，或恰好补齐缺失片）
      sendEnd: options.sendEnd ?? (hasResume ? coversMissing : indexes.length === total)
    }
  }

  /** 把计划变成引擎能直接执行的任务（帧按需渲染 + 发送前自检）。 */
  createRequest(
    options: StartFramesOptions = {},
    hooks: { onFrame?: (index: number, ok: boolean, error?: string) => void } = {}
  ): { request: Extract<TypingRequest, { kind: 'frames' }>; plan: FramePlan } {
    const job = this.requireJob()
    const plan = this.plan(options)

    return {
      plan,
      request: {
        kind: 'frames',
        jobId: job.summary.job,
        total: job.summary.total,
        indexes: plan.indexes,
        render: (index) => job.renderFrame(index),
        charsOf: (index) => job.frameChars(index),
        begin: plan.sendBegin ? () => job.beginFrame() : undefined,
        end: plan.sendEnd ? () => job.endFrame() : undefined,
        onFrame: hooks.onFrame
      }
    }
  }

  async dispose(): Promise<void> {
    const job = this.current
    this.current = null
    if (job) await job.dispose()
  }

  private requireJob(): PreparedTransfer {
    if (!this.current) {
      throw new TransferError('no-job', '还没有选择文件：请先在「文件」模式里选择要输入的文件')
    }
    return this.current
  }
}

/**
 * 把 `tools/`（接收脚本与线格式文档）复制到用户选择的目录。
 *
 * 目标机没有 Node 包管理器，用户需要的是"能直接拷过去跑的文件"，所以这里按文件复制而不是打包成 zip。
 */
export function copyToolsTo(toolsDir: string, destination: string): string[] {
  mkdirSync(destination, { recursive: true })
  const copied: string[] = []

  const walk = (relative: string): void => {
    const source = relative.length > 0 ? join(toolsDir, relative) : toolsDir
    for (const entry of readdirSync(source)) {
      const child = relative.length > 0 ? join(relative, entry) : entry
      const full = join(toolsDir, child)
      if (statSync(full).isDirectory()) {
        walk(child)
        continue
      }
      const target = join(destination, child)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(full, target)
      copied.push(child)
    }
  }

  walk('')
  return copied
}
