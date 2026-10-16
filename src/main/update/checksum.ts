/**
 * 校验和工具：流式计算文件 SHA-256、解析发布包里的校验和清单。
 * 更新流程必须能回答"下载到的安装包是不是官方发布的那一个"，因此这里只做最朴素、最容易审计的事。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * @description 流式计算文件的 SHA-256（十六进制小写）
 * @param filePath 文件路径
 * @returns 摘要
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * @description 计算一段内存数据的 SHA-256（便于测试与小块校验）
 * @param text 文本内容
 * @returns 十六进制摘要
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * @description 把 `sha256:abcd…` 形式的摘要规范成裸十六进制
 * @param digest 原始摘要（可缺省）
 * @returns 64 位十六进制小写摘要；不合法时返回 null
 */
export function normalizeDigest(digest: string | undefined): string | null {
  if (!digest) return null
  const value = digest
    .trim()
    .replace(/^sha256:/i, '')
    .toLowerCase()
  return /^[0-9a-f]{64}$/.test(value) ? value : null
}

/**
 * @description 从校验和清单里取出指定文件名的摘要；支持 `<hash>  <file>`、`<hash> *<file>` 与 `SHA256 (<file>) = <hash>` 三种写法
 * @param text 清单全文
 * @param fileName 目标文件名（不区分大小写）
 * @returns 十六进制小写摘要，未找到时返回 null
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

/**
 * @description 恒定时间比较两个摘要，避免比较过程本身泄露信息
 * @param a 摘要 A
 * @param b 摘要 B
 * @returns 是否相等
 */
export function digestEquals(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}
