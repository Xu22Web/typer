/**
 * GitHub Release 客户端：只依赖注入进来的 fetch，不直接引用 Electron，
 * 因此限流、无发布、无安装包、网络错误等分支都能在单元测试里覆盖。
 */
import type { ReleaseAssetInfo, ReleaseInfo } from './types'
import { normalizeVersion, parseVersion } from './semver'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GithubClientOptions {
  owner: string
  repo: string
  fetch: FetchLike
  /** GitHub 要求带 UA，否则匿名请求容易被拒 */
  userAgent: string
  /** 便于测试指向本地服务 */
  apiBase?: string
  timeoutMs?: number
}

const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * @description 从发布产物里挑选安装包，顺序为：精确匹配文件名 → 任意 setup.exe → 任意 exe
 * @param assets 发布产物列表
 * @param repo 仓库名
 * @param version 归一化版本号
 * @returns 选中的产物；没有合适产物时返回 null
 */
function pickInstallerAsset(
  assets: ReleaseAssetInfo[],
  repo: string,
  version: string
): ReleaseAssetInfo | null {
  const exactNames = [
    `${repo}-${version}-setup.exe`.toLowerCase(),
    `${repo}-setup-${version}.exe`.toLowerCase()
  ]

  const byName = assets.find((asset) => exactNames.includes(asset.name.toLowerCase()))
  if (byName) return byName

  const setup = assets.find((asset) => /-setup\.exe$/i.test(asset.name))
  if (setup) return setup

  return assets.find((asset) => /\.exe$/i.test(asset.name)) ?? null
}

/**
 * @description 从发布产物里挑选校验和清单（优先字面名 sha256sums，其次含 sha256 的 txt/sums）
 * @param assets 发布产物列表
 * @returns 选中的产物；没有时返回 null
 */
function pickChecksumAsset(assets: ReleaseAssetInfo[]): ReleaseAssetInfo | null {
  return (
    assets.find((asset) => /^sha256sums(\.txt|\.sha256|\.sums)?$/i.test(asset.name)) ??
    assets.find((asset) => /sha256.*\.(txt|sums)$/i.test(asset.name)) ??
    null
  )
}

interface GithubAssetPayload {
  name?: unknown
  size?: unknown
  browser_download_url?: unknown
  digest?: unknown
}

interface GithubReleasePayload {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

/**
 * @description 把 GitHub 的产物 JSON 收窄成本地类型（缺名字或缺下载地址视为无效产物）
 * @param raw 原始产物 JSON
 * @returns 产物信息；无效时返回 null
 */
function toAssetInfo(raw: GithubAssetPayload): ReleaseAssetInfo | null {
  const name = typeof raw.name === 'string' ? raw.name : null
  const url = typeof raw.browser_download_url === 'string' ? raw.browser_download_url : null
  if (!name || !url) return null
  return {
    name,
    size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0,
    url,
    digest: typeof raw.digest === 'string' && raw.digest.length > 0 ? raw.digest : null
  }
}

/**
 * @description 读取最新正式版发布；用 /releases/latest 而不是 /releases，因为 GitHub 保证前者是"最新非预发布版"，不必在客户端重复实现过滤
 * @param options owner/repo、fetch 实现、UA 与可选的 apiBase / 超时
 * @returns 归一化后的发布信息
 */
export async function fetchLatestRelease(options: GithubClientOptions): Promise<ReleaseInfo> {
  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const url = `${base}/repos/${options.owner}/${options.repo}/releases/latest`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const response = await options.fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': options.userAgent
    },
    signal: AbortSignal.timeout(timeoutMs)
  })

  if (!response.ok) {
    throw new Error(await describeHttpFailure(response))
  }

  const payload = (await response.json()) as GithubReleasePayload
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : ''
  const version = normalizeVersion(tag)
  if (!tag || !parseVersion(tag)) {
    throw new Error('发布信息异常：标签不是有效的版本号')
  }

  const assets = Array.isArray(payload.assets)
    ? payload.assets
        .map((asset) => toAssetInfo(asset as GithubAssetPayload))
        .filter((asset): asset is ReleaseAssetInfo => asset !== null)
    : []

  const checksumAsset = pickChecksumAsset(assets)
  const installer = pickInstallerAsset(assets, options.repo, version)

  return {
    tag,
    version,
    title: typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : tag,
    notes: typeof payload.body === 'string' ? payload.body : '',
    publishedAt: typeof payload.published_at === 'string' ? payload.published_at : '',
    pageUrl:
      typeof payload.html_url === 'string'
        ? payload.html_url
        : `https://github.com/${options.owner}/${options.repo}/releases`,
    asset: installer,
    checksumUrl: checksumAsset?.url ?? null
  }
}

/**
 * @description 把 HTTP 失败翻译成能直接展示给用户的中文原因
 * @param response 失败的响应
 * @returns 中文原因
 */
async function describeHttpFailure(response: Response): Promise<string> {
  const status = response.status

  if (status === 404) {
    return '未找到发布信息（仓库可能还没有创建 Release）'
  }
  if (status === 403 || status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    if (remaining === '0') return 'GitHub 接口访问频率超限，请稍后再试'
    return 'GitHub 拒绝访问（403），请稍后再试'
  }
  if (status >= 500) {
    return `GitHub 服务暂时不可用（HTTP ${status}）`
  }

  let detail = ''
  try {
    const body = (await response.json()) as { message?: unknown }
    if (typeof body.message === 'string') detail = `：${body.message}`
  } catch {
    // 响应不是 JSON，忽略
  }
  return `检查更新失败（HTTP ${status}${detail}）`
}

/**
 * @description 读取校验和清单等纯文本资源
 * @param url 资源地址
 * @param options fetch 实现、UA 与可选超时
 * @returns 响应正文
 */
export async function fetchText(
  url: string,
  options: { fetch: FetchLike; userAgent: string; timeoutMs?: number }
): Promise<string> {
  const response = await options.fetch(url, {
    headers: { 'user-agent': options.userAgent },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(await describeHttpFailure(response))
  }
  return response.text()
}
