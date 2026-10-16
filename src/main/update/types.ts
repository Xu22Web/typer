/** 更新模块的共享类型（主进程与渲染进程共用，全部是纯数据）。 */

export interface ReleaseAssetInfo {
  name: string
  /** 字节数；GitHub 未提供时为 0 */
  size: number
  /** 下载地址（browser_download_url，会 302 到对象存储） */
  url: string
  /** GitHub 计算的摘要，形如 `sha256:…`（部分仓库/旧接口没有该字段） */
  digest: string | null
}

export interface ReleaseInfo {
  /** 原始标签，例如 `v0.2.0` */
  tag: string
  /** 归一化版本号，例如 `0.2.0` */
  version: string
  /** 发布标题；为空时回退到标签 */
  title: string
  /** 发布说明（Markdown 原文） */
  notes: string
  /** ISO 时间字符串 */
  publishedAt: string
  /** Release 页面地址（在浏览器里打开） */
  pageUrl: string
  /** 选中的安装包；无合适产物时为 null */
  asset: ReleaseAssetInfo | null
  /** SHA256SUMS.txt 的下载地址（发布流程会附带） */
  checksumUrl: string | null
}

export type UpdateCheckStatus =
  /** 当前已是最新 */
  | 'up-to-date'
  /** 有新版本可用 */
  | 'available'
  /** 非安装版（开发模式）或未配置仓库，无法自更新 */
  | 'unsupported'
  /** 检查失败（离线、被限流、仓库不存在…） */
  | 'error'

export interface UpdateCheckResult {
  status: UpdateCheckStatus
  /** 当前版本 */
  current: string
  /** 最新版本（检查成功时存在） */
  latest: ReleaseInfo | null
  /** 失败原因（status 为 error / unsupported 时存在） */
  message?: string
  /** 检查完成时间（毫秒） */
  checkedAt: number
}

export type UpdateDownloadStatus =
  | 'idle'
  | 'downloading'
  | 'verifying'
  /** 已下载并通过完整性校验，可以安装 */
  | 'ready'
  /** 下载完成但无法校验（发布缺少校验和），只能手动安装 */
  | 'unverified'
  | 'failed'

export interface UpdateProgress {
  /** 已接收字节 */
  received: number
  /** 总字节（未知时为 0） */
  total: number
  /** 0–1；总长度未知时为 0 */
  percent: number
  /** 瞬时速度（字节/秒） */
  bytesPerSecond: number
}

export interface UpdateState {
  status: UpdateDownloadStatus
  /** 下载进度；非下载态时为 null */
  progress: UpdateProgress | null
  /** 下载到本地的安装包路径 */
  filePath: string | null
  /** 本地计算的 SHA-256（已校验时为通过的那个值） */
  sha256: string | null
  /** 校验基准：来自 SHA256SUMS.txt 还是 GitHub 摘要 */
  verifiedBy: 'manifest' | 'api-digest' | null
  /** 失败原因 */
  error: string | null
}
