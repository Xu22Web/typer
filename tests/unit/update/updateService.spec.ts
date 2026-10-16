import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdateService } from '@main/update/updateService'
import type { FetchLike } from '@main/update/githubClient'
import type { UpdateProgress, UpdateState } from '@main/update/types'

const OWNER = 'Xu22Web'
const REPO = 'typer'
const INSTALLER = 'typer-0.2.0-setup.exe'

/**
 * @description 造一段"安装包"内容（几百 KB，确保走多块流式写入）
 * @param seed 内容前缀
 * @returns 安装包字节
 */
function makeInstallerBytes(seed = 'typer'): Buffer {
  return Buffer.from(`${seed}-${'payload'.repeat(20_000)}`, 'utf8')
}

/**
 * @description 计算字节内容的 SHA-256 十六进制摘要
 * @param buffer 待计算内容
 * @returns 十六进制摘要
 */
function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

interface FakeServerOptions {
  version?: string
  bytes?: Buffer
  /** 是否附带 SHA256SUMS.txt 产物 */
  withManifest?: boolean
  /** 清单里的摘要（默认正确） */
  manifestDigest?: string
  /** GitHub 的 asset.digest 字段 */
  apiDigest?: string | null
  /** 是否提供安装包产物 */
  withAsset?: boolean
  /** 声明的内容长度（默认取真实长度；用于测试截断） */
  declaredLength?: number
  /** 每次下载返回的内容（默认与 bytes 相同） */
  downloadBytes?: Buffer
  /** 下载响应的状态码 */
  downloadStatus?: number
  rateLimited?: boolean
}

interface FakeServer {
  calls: string[]
  fetch: FetchLike
  downloadCount: () => number
}

/**
 * @description 造一个模拟 GitHub Releases 的 fetch 实现
 * @param options 服务端行为开关
 * @returns 调用记录、fetch 与下载计数
 */
function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const bytes = options.bytes ?? makeInstallerBytes()
  const version = options.version ?? '0.2.0'
  const calls: string[] = []
  let downloads = 0

  const manifestText = `${options.manifestDigest ?? sha256(bytes)}  ${INSTALLER}\n`

  const fetch: FetchLike = async (url, init) => {
    calls.push(url)

    if (options.rateLimited) {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' }
      })
    }

    if (url.includes('/releases/latest')) {
      const assets: Array<Record<string, unknown>> = []
      if (options.withManifest) {
        assets.push({
          name: 'SHA256SUMS.txt',
          size: manifestText.length,
          browser_download_url: `https://example.test/${version}/SHA256SUMS.txt`
        })
      }
      if (options.withAsset !== false) {
        assets.push({
          name: INSTALLER,
          size: bytes.byteLength,
          browser_download_url: `https://example.test/${version}/${INSTALLER}`,
          ...(options.apiDigest === undefined ? {} : { digest: options.apiDigest })
        })
      }

      return new Response(
        JSON.stringify({
          tag_name: `v${version}`,
          name: `typer ${version}`,
          body: '## 更新内容\n- 新增更新检查',
          published_at: '2026-02-01T00:00:00Z',
          html_url: `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`,
          assets
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }

    if (url.endsWith('SHA256SUMS.txt')) {
      return new Response(manifestText, { status: 200 })
    }

    if (url.includes(INSTALLER)) {
      downloads += 1
      const body = options.downloadBytes ?? bytes
      // 即便没有 signal，流式响应也支持 abort（pipeline 会处理）
      void init
      return new Response(new Uint8Array(body), {
        status: options.downloadStatus ?? 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(options.declaredLength ?? body.byteLength)
        }
      })
    }

    return new Response('not found', { status: 404 })
  }

  return { calls, fetch, downloadCount: () => downloads }
}

interface Harness {
  dir: string
  service: ReturnType<typeof createUpdateService>
  states: UpdateState[]
  progress: UpdateProgress[]
  installed: string[]
  quit: () => boolean
}

/**
 * @description 造一个接了假服务器、记录状态/进度/安装调用的更新服务
 * @param serverOptions 假服务器行为开关
 * @param overrides 覆盖服务依赖（当前版本、打包状态、安装器启动）
 * @returns 服务与观测记录
 */
function createHarness(
  serverOptions: FakeServerOptions = {},
  overrides: {
    currentVersion?: string
    isPackaged?: boolean
    launchInstaller?: (filePath: string) => void
  } = {}
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'typer-update-'))
  const server = createFakeServer(serverOptions)
  const states: UpdateState[] = []
  const progress: UpdateProgress[] = []
  const installed: string[] = []
  let quitCalled = false

  const service = createUpdateService({
    currentVersion: overrides.currentVersion ?? '0.1.0',
    owner: OWNER,
    repo: REPO,
    fetch: server.fetch,
    downloadDir: dir,
    isPackaged: overrides.isPackaged ?? true,
    userAgent: 'typer-test',
    onState: (state) => states.push(state),
    onProgress: (value) => progress.push(value),
    launchInstaller: (filePath) => {
      installed.push(filePath)
      overrides.launchInstaller?.(filePath)
    },
    quitApp: () => {
      quitCalled = true
    }
  })

  return {
    dir,
    service,
    states,
    progress,
    installed,
    quit: () => quitCalled
  }
}

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * @description 把 harness 的临时目录登记到 afterEach 清理列表
 * @param harness 待登记的 harness
 * @returns 同一个 harness
 */
function track(harness: Harness): Harness {
  created.push(harness.dir)
  return harness
}

describe('更新检查', () => {
  it('发现新版本时给出发布信息与安装包', async () => {
    const h = track(createHarness({ withManifest: true }))
    const result = await h.service.check({ force: true })

    expect(result.status).toBe('available')
    expect(result.current).toBe('0.1.0')
    expect(result.latest?.version).toBe('0.2.0')
    expect(result.latest?.asset?.name).toBe(INSTALLER)
    expect(result.latest?.checksumUrl).toContain('SHA256SUMS.txt')
    expect(result.latest?.notes).toContain('更新内容')
  })

  it('当前已是最新时不提示更新', async () => {
    const h = track(createHarness({ version: '0.1.0' }))
    const result = await h.service.check({ force: true })

    expect(result.status).toBe('up-to-date')
    expect(result.latest?.version).toBe('0.1.0')
  })

  it('发布缺少安装包时仍算有更新（由下载阶段给出提示）', async () => {
    const h = track(createHarness({ withAsset: false }))
    const result = await h.service.check({ force: true })

    expect(result.status).toBe('available')
    expect(result.latest?.asset).toBeNull()
  })

  it('节流：短时间内重复检查复用上次结果，force 时重新请求', async () => {
    const h = track(createHarness())
    await h.service.check()
    const first = h.service.lastCheck()

    const second = await h.service.check()
    expect(second).toBe(first)

    await h.service.check({ force: true })
    expect(h.service.lastCheck()).not.toBe(first)
  })

  it('离线或接口报错时返回 error 而不是抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typer-update-'))
    created.push(dir)
    const service = createUpdateService({
      currentVersion: '0.1.0',
      owner: OWNER,
      repo: REPO,
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      },
      downloadDir: dir,
      isPackaged: true
    })

    const result = await service.check({ force: true })
    expect(result.status).toBe('error')
    expect(result.message).toContain('ENOTFOUND')
  })

  it('限流时给出可读原因', async () => {
    const h = track(createHarness({ rateLimited: true }))
    const result = await h.service.check({ force: true })

    expect(result.status).toBe('error')
    expect(result.message).toContain('频率超限')
  })

  it('开发模式下不支持自动更新', async () => {
    const h = track(createHarness({}, { isPackaged: false }))
    const result = await h.service.check({ force: true })

    expect(result.status).toBe('unsupported')
    expect(result.message).toContain('开发模式')
  })
})

describe('下载与完整性校验', () => {
  it('校验通过后状态为 ready，并记录校验来源', async () => {
    const h = track(createHarness({ withManifest: true }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('ready')
    expect(state.verifiedBy).toBe('manifest')
    expect(state.sha256).toBe(sha256(makeInstallerBytes()))
    expect(state.filePath && existsSync(state.filePath)).toBe(true)
    expect(h.progress.length).toBeGreaterThan(0)
    expect(h.progress.at(-1)?.percent).toBe(1)
  })

  it('没有清单时退回 GitHub 摘要', async () => {
    const bytes = makeInstallerBytes('api')
    const h = track(createHarness({ bytes, apiDigest: `sha256:${sha256(bytes)}` }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('ready')
    expect(state.verifiedBy).toBe('api-digest')
  })

  it('摘要不匹配时删除文件并报错（不把可疑安装包留在磁盘上）', async () => {
    const bytes = makeInstallerBytes('real')
    const h = track(createHarness({ bytes, withManifest: true, manifestDigest: 'f'.repeat(64) }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('failed')
    expect(state.error).toContain('完整性校验失败')
    expect(state.filePath).toBeNull()
    expect(existsSync(join(h.dir, INSTALLER))).toBe(false)
  })

  it('发布既无清单也无摘要时标记为 unverified，不自动安装', async () => {
    const h = track(createHarness({ apiDigest: null }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('unverified')
    expect(state.error).toContain('无法验证安装包完整性')
    // 文件保留，供用户手动核对/安装
    expect(state.filePath && existsSync(state.filePath)).toBe(true)

    const installed = h.service.install()
    expect(installed.status).toBe('failed')
    expect(h.installed).toHaveLength(0)
  })

  it('文件大小与发布不一致时判为失败', async () => {
    const bytes = makeInstallerBytes('size')
    const h = track(
      createHarness({ bytes, withManifest: true, declaredLength: bytes.byteLength + 10 })
    )
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('failed')
    expect(state.error).toContain('下载不完整')
  })

  it('HTTP 错误时给出状态码提示', async () => {
    const h = track(createHarness({ downloadStatus: 500 }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('failed')
    expect(state.error).toContain('HTTP 500')
  })

  it('没有安装包产物时明确提示', async () => {
    const h = track(createHarness({ withAsset: false }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(state.status).toBe('failed')
    expect(state.error).toContain('没有提供 Windows 安装包')
  })

  it('已就绪时重复下载直接返回，不重复请求', async () => {
    const bytes = makeInstallerBytes('cache')
    const server = createFakeServer({ withManifest: true, bytes })
    const dir = mkdtempSync(join(tmpdir(), 'typer-update-'))
    created.push(dir)

    const service = createUpdateService({
      currentVersion: '0.1.0',
      owner: OWNER,
      repo: REPO,
      fetch: server.fetch,
      downloadDir: dir,
      isPackaged: true
    })

    await service.check({ force: true })
    await service.download()
    const before = server.downloadCount()
    const second = await service.download()

    expect(second.status).toBe('ready')
    expect(server.downloadCount()).toBe(before)
  })

  it('取消下载时状态为 failed 且不残留半成品', async () => {
    const h = track(createHarness())
    await h.service.check({ force: true })

    const pending = h.service.download()
    h.service.cancelDownload()
    const state = await pending

    expect(state.status).toBe('failed')
    expect(state.error).toBe('已取消下载')
    expect(existsSync(join(h.dir, INSTALLER))).toBe(false)
  })
})

describe('安装', () => {
  it('校验通过后启动安装程序并退出应用', async () => {
    const h = track(createHarness({ withManifest: true }))
    await h.service.check({ force: true })
    await h.service.download()

    const state = h.service.install()
    expect(state.status).toBe('idle')
    expect(h.installed).toHaveLength(1)
    expect(h.installed[0]).toBe(join(h.dir, INSTALLER))
    expect(h.quit()).toBe(true)
  })

  it('安装包被外部清理时报错而不是启动一个不存在的文件', async () => {
    const h = track(createHarness({ withManifest: true }))
    await h.service.check({ force: true })
    const ready = await h.service.download()
    rmSync(ready.filePath as string, { force: true })

    const state = h.service.install()
    expect(state.status).toBe('failed')
    expect(state.error).toContain('已被清理')
    expect(h.installed).toHaveLength(0)
  })

  it('尚未下载就安装会被拒绝', () => {
    const h = track(createHarness())
    const state = h.service.install()

    expect(state.status).toBe('failed')
    expect(state.error).toContain('没有通过校验的安装包')
  })

  it('启动安装程序抛错时把原因带回界面，且不退出应用', async () => {
    const h = track(
      createHarness(
        { withManifest: true },
        {
          launchInstaller: () => {
            throw new Error('EACCES')
          }
        }
      )
    )
    await h.service.check({ force: true })
    await h.service.download()

    const state = h.service.install()
    expect(state.status).toBe('failed')
    expect(state.error).toContain('EACCES')
    expect(h.quit()).toBe(false)
  })
})

describe('下载文件内容', () => {
  it('落盘内容与响应完全一致（流式写入没有截断）', async () => {
    const bytes = makeInstallerBytes('stream')
    const h = track(createHarness({ bytes, withManifest: true }))
    await h.service.check({ force: true })
    const state = await h.service.download()

    expect(readFileSync(state.filePath as string).equals(bytes)).toBe(true)
  })
})
