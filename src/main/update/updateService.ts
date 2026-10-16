/**
 * 更新服务：检查 → 下载 → 完整性校验 → 交给安装程序。
 *
 * 设计取舍：
 *  - **不做"静默自动安装"**。安装包是 NSIS 交互式安装向导，静默安装会在应用仍在运行时
 *    替换自身文件，风险大于收益；这里只负责把安装包准备到"可安装"状态，由用户确认后启动。
 *  - **校验失败就当失败**。发布缺少校验和时不自动安装（状态 `unverified`），
 *    界面改为提供浏览器下载入口，避免把"来源不明的可执行文件"直接推给用户。
 *  - 所有外部依赖（fetch、spawn、路径、时钟）都从参数注入，方便测试与替换。
 */
import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { digestEquals, normalizeDigest, parseChecksumManifest, sha256File } from './checksum'
import { DownloadCancelledError, downloadToFile } from './downloader'
import { fetchLatestRelease, fetchText, type FetchLike } from './githubClient'
import { isNewerVersion } from './semver'
import type {
  ReleaseInfo,
  UpdateCheckResult,
  UpdateProgress,
  UpdateState,
  UpdateState as UpdateStatePayload
} from './types'

export interface UpdateServiceOptions {
  /** 当前版本（来自 app.getVersion()） */
  currentVersion: string
  owner: string
  repo: string
  fetch: FetchLike
  /** 下载目录（通常 %TEMP%\Typer-update） */
  downloadDir: string
  /** 是否为安装版；开发模式下自更新无意义 */
  isPackaged: boolean
  userAgent?: string
  /** 启动安装程序（默认用 detach 方式） */
  launchInstaller?: (filePath: string) => void
  /** 退出应用，让安装程序替换文件 */
  quitApp?: () => void
  onState?: (state: UpdateStatePayload) => void
  onProgress?: (progress: UpdateProgress) => void
  /** 检查超时（毫秒） */
  timeoutMs?: number
}

export interface UpdateService {
  /** 检查是否有新版本（用户主动触发时 force = true，会绕过节流缓存） */
  check: (options?: { force?: boolean }) => Promise<UpdateCheckResult>
  /** 下载最新版安装包并校验完整性 */
  download: () => Promise<UpdateState>
  /** 取消正在进行的下载 */
  cancelDownload: () => void
  /** 启动已下载的安装包并退出应用 */
  install: () => UpdateState
  /** 当前状态快照 */
  state: () => UpdateState
  /** 最近一次检查结果（未检查过为 null） */
  lastCheck: () => UpdateCheckResult | null
}

const IDLE_STATE: UpdateState = {
  status: 'idle',
  progress: null,
  filePath: null,
  sha256: null,
  verifiedBy: null,
  error: null
}

/** 主动检查的最小间隔：避免用户连点按钮时打满 GitHub 匿名接口的额度。 */
const CHECK_THROTTLE_MS = 30_000

export function createUpdateService(options: UpdateServiceOptions): UpdateService {
  const userAgent = options.userAgent ?? `Typer-updater/${options.currentVersion}`
  const timeoutMs = options.timeoutMs ?? 15_000

  let state: UpdateState = { ...IDLE_STATE }
  let lastCheck: UpdateCheckResult | null = null
  let controller: AbortController | null = null

  const publish = (patch: Partial<UpdateState>): void => {
    state = { ...state, ...patch }
    options.onState?.(state)
  }

  const isUnsupported = (): string | null => {
    if (!options.isPackaged) return '开发模式下不支持自动更新（仅在安装版中可用）'
    if (!options.owner || !options.repo) return '未配置更新仓库地址'
    return null
  }

  async function check(checkOptions: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    const unsupported = isUnsupported()
    if (unsupported) {
      const result: UpdateCheckResult = {
        status: 'unsupported',
        current: options.currentVersion,
        latest: null,
        message: unsupported,
        checkedAt: Date.now()
      }
      lastCheck = result
      return result
    }

    if (!checkOptions.force && lastCheck && Date.now() - lastCheck.checkedAt < CHECK_THROTTLE_MS) {
      return lastCheck
    }

    try {
      const latest = await fetchLatestRelease({
        owner: options.owner,
        repo: options.repo,
        fetch: options.fetch,
        userAgent,
        timeoutMs
      })

      const result: UpdateCheckResult = {
        status: isNewerVersion(latest.version, options.currentVersion) ? 'available' : 'up-to-date',
        current: options.currentVersion,
        latest,
        checkedAt: Date.now()
      }
      lastCheck = result
      return result
    } catch (error) {
      const result: UpdateCheckResult = {
        status: 'error',
        current: options.currentVersion,
        latest: null,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now()
      }
      lastCheck = result
      return result
    }
  }

  /** 下载 + 校验，返回最终状态（不抛错，把失败原因写进 state）。 */
  async function download(): Promise<UpdateState> {
    if (state.status === 'downloading' || state.status === 'verifying') return state
    if (state.status === 'ready' && state.filePath && existsSync(state.filePath)) return state

    const unsupported = isUnsupported()
    if (unsupported) {
      publish({ status: 'failed', error: unsupported })
      return state
    }

    const result = lastCheck ?? (await check({ force: true }))
    const latest = result.latest
    if (!latest) {
      publish({ status: 'failed', error: result.message ?? '没有可用的新版本信息' })
      return state
    }
    if (!latest.asset) {
      publish({ status: 'failed', error: `发布 ${latest.tag} 没有提供 Windows 安装包` })
      return state
    }

    const asset = latest.asset
    const destination = join(options.downloadDir, asset.name)

    controller = new AbortController()
    publish({
      status: 'downloading',
      progress: { received: 0, total: asset.size, percent: 0, bytesPerSecond: 0 },
      filePath: null,
      sha256: null,
      verifiedBy: null,
      error: null
    })

    try {
      await mkdir(options.downloadDir, { recursive: true })
      // 清掉上一次可能留下的同名文件，避免增量写坏
      await rm(destination, { force: true })

      await downloadToFile({
        url: asset.url,
        destPath: destination,
        fetch: options.fetch,
        userAgent,
        signal: controller.signal,
        onProgress: (progress) => {
          state = { ...state, progress }
          options.onProgress?.(progress)
        }
      })

      publish({ status: 'verifying', progress: null })
      const actual = await sha256File(destination)
      const expected = await resolveExpectedDigest(latest, asset.name, asset.digest)

      if (!expected) {
        publish({
          status: 'unverified',
          filePath: destination,
          sha256: actual,
          verifiedBy: null,
          error: '发布未提供 SHA-256 校验和，无法验证安装包完整性'
        })
        return state
      }

      if (!digestEquals(actual, expected.digest)) {
        await rm(destination, { force: true })
        publish({
          status: 'failed',
          filePath: null,
          sha256: actual,
          verifiedBy: null,
          error: '完整性校验失败：安装包摘要与发布校验和不一致，已删除下载文件'
        })
        return state
      }

      // 顺带核对文件大小（校验和已经足够，这里只是多一层廉价保险）
      const size = await stat(destination)
      if (asset.size > 0 && size.size !== asset.size) {
        await rm(destination, { force: true })
        publish({
          status: 'failed',
          filePath: null,
          sha256: actual,
          verifiedBy: null,
          error: `文件大小与发布不一致（期望 ${asset.size}，实际 ${size.size}）`
        })
        return state
      }

      publish({
        status: 'ready',
        filePath: destination,
        sha256: actual,
        verifiedBy: expected.source,
        error: null
      })
      return state
    } catch (error) {
      const message =
        error instanceof DownloadCancelledError
          ? '已取消下载'
          : error instanceof Error
            ? error.message
            : String(error)
      publish({ status: 'failed', progress: null, error: message })
      return state
    } finally {
      controller = null
    }
  }

  /** 启动安装程序并退出，让向导接管后续步骤。 */
  function install(): UpdateState {
    if (state.status !== 'ready' || !state.filePath) {
      publish({ status: 'failed', error: '没有通过校验的安装包，无法安装' })
      return state
    }
    if (!existsSync(state.filePath)) {
      publish({ status: 'failed', filePath: null, error: '安装包已被清理，请重新下载' })
      return state
    }

    try {
      options.launchInstaller?.(state.filePath)
      publish({ status: 'idle', progress: null })
      options.quitApp?.()
    } catch (error) {
      publish({
        status: 'failed',
        error: `启动安装程序失败：${error instanceof Error ? error.message : String(error)}`
      })
    }
    return state
  }

  /**
   * 确定用于校验的摘要。
   *
   * 优先级：发布附带的 SHA256SUMS.txt > GitHub 接口给出的 asset.digest。
   * 清单优先是因为它由我们的发布流程生成，且能覆盖"GitHub 未计算摘要"的仓库。
   */
  async function resolveExpectedDigest(
    latest: ReleaseInfo,
    fileName: string,
    apiDigest: string | null
  ): Promise<{ digest: string; source: 'manifest' | 'api-digest' } | null> {
    if (latest.checksumUrl) {
      try {
        const text = await fetchText(latest.checksumUrl, { fetch: options.fetch, userAgent })
        const fromManifest = parseChecksumManifest(text, fileName)
        if (fromManifest) return { digest: fromManifest, source: 'manifest' }
      } catch {
        // 清单拿不到就退回 GitHub 摘要，不因此判定失败
      }
    }

    const fromApi = normalizeDigest(apiDigest ?? undefined)
    if (fromApi) return { digest: fromApi, source: 'api-digest' }

    return null
  }

  return {
    check,
    download,
    cancelDownload: () => {
      controller?.abort()
    },
    install,
    state: () => state,
    lastCheck: () => lastCheck
  }
}
