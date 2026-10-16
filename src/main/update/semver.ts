/**
 * 版本号比较（不引入依赖）。
 *
 * 只处理 GitHub Release 标签里会出现的形态：`v1.2.3`、`1.2.3`、`1.2.3-beta.4`。
 * 构建元数据（`+build.5`）按 semver 规范忽略，因为它不参与优先级比较。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识段（beta/rc…），空数组表示正式版 */
  prerelease: string[]
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/

export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(input.trim().replace(/\+.*$/, ''))
  if (!match) return null

  return {
    major: Number(match[1] ?? 0),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split('.').filter((part) => part.length > 0) : []
  }
}

/**
 * 比较两个版本：a > b 返回正数，a < b 返回负数，相等返回 0。
 *
 * 无法解析的版本视为最小，避免把奇怪的标签当成新版本推给用户。
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }

  // 正式版 > 预发布版（semver 2.0.0 第 11 条）
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue

    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null

    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
    // 数字标识符的优先级低于字母标识符
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return leftPart < rightPart ? -1 : 1
  }

  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** 去掉标签里的 `v` 前缀，用于界面显示。 */
export function normalizeVersion(tag: string): string {
  const parsed = parseVersion(tag)
  if (!parsed) return tag
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length > 0 ? `${base}-${parsed.prerelease.join('.')}` : base
}
