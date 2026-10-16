/**
 * 校验和工具：计算文件 SHA-256、解析发布包里的校验和清单。
 *
 * 更新流程**必须**能回答"我下载的这个安装包是不是官方发布的那一个"，
 * 因此这里只做最朴素、最容易审计的事：流式计算 SHA-256，逐字比较十六进制摘要。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** 流式计算文件的 SHA-256（十六进制小写）。 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 计算一段内存数据的 SHA-256，便于测试与小块校验。 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 把 `sha256:abcd…` 形式的摘要规范成裸十六进制。 */
export function normalizeDigest(digest: string | undefined): string | null {
  if (!digest) return null
  const value = digest
    .trim()
    .replace(/^sha256:/i, '')
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(value) ? value : null
}

/**
 * 从校验和清单中取出指定文件名的摘要。
 *
 * 同时支持两种常见格式：
 *   `<hash>  <file>`      （sha256sum / certutil 输出）
 *   `<hash> *<file>`      （sha256sum -b）
 *   `SHA256 (<file>) = <hash>`  （Windows `certutil -hashfile` / BoringSSL 风格）
 */
export function parseChecksumManifest(text: string, fileName: string): string | null {
  const target = fileName.toLowerCase()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const certutil = /^SHA256\s*\((?<name>.+?)\)\s*=\s*(?<hash>[0-9a-fA-F]{64})$/.exec(line)
    if (certutil) {
      if (certutil.groups?.name?.trim().toLowerCase() === target) {
        return certutil.groups.hash.toLowerCase()
      }
      continue
    }

    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const hash = parts[0] ?? ''
    const name = (parts[1] ?? '').replace(/^\*/, '')
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) continue
    if (name.toLowerCase() === target) return hash.toLowerCase()
  }

  return null
}

/** 恒定时间比较，避免把"摘要比较"变成侧信道（这里只是好习惯，威胁模型并不需要）。 */
export function digestEquals(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}
