// 线格式的载荷编码：把字节流压进「每个字符 5/6/4 比特」的符号表。
//
// 为什么不是 hex / base64：帧是逐字符真实按键打出去的，字符数就是耗时。
// 但远程桌面（RDP / Citrix）只转发真实键盘事件，大写与符号需要 Shift，而修饰键在链路里
// 必须单独一次 SendInput 并留间隔（实测 >10ms），因此每字符的 Shift 都是真实的额外开销。
// 所以默认用零 Shift 的 5 位表：
//   · hex      4 bit/字符 → 一个字节要 2 个字符
//   · ascii64  6 bit/字符 → 3 个字节 4 个字符，但一半字符需要 Shift
//   · ascii32  5 bit/字符 → 8 个字节 12.8 个字符，全部是小写字母/数字，无需 Shift
//
// 只用 node: 内置模块、零第三方依赖，Node >= 16 可运行；主进程与接收端脚本共用这一份实现。

/** 载荷符号表标识（写进开始帧的 `alpha` 字段）。 */
export type AlphabetId = 'ascii32' | 'ascii64' | 'hex'

/** 符号表：`bits` 位/字符，`table[i]` 是索引 i 对应的 UTF-16 码元。 */
export interface Alphabet {
  id: AlphabetId
  /** 每个字符承载的比特数 */
  bits: number
  /** 索引 → 码元 */
  table: readonly number[]
  /** 码元 → 索引 */
  index: ReadonlyMap<number, number>
}

/**
 * 载荷错误：`code` 与帧协议的错误码保持一致（统一为 enc），
 * 避免 codec 反向依赖 frame.ts 造成循环引用。
 */
export class CodecError extends Error {
  declare readonly name: 'CodecError'
  declare readonly code: 'enc'
  declare readonly detail?: string

  /**
   * @description 构造载荷编解码错误
   * @param message 面向用户的说明
   * @param detail 附加细节（不包含数据原文）
   */
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'CodecError'
    this.code = 'enc'
    this.detail = detail
  }
}

/**
 * 5 bit 符号表：数字 + 小写字母（不含容易受编辑器/输入法影响的符号），共 32 个。
 * 全部无需 Shift：远程桌面下不会触发修饰键开销，也不会撞上输入法中英文切换。
 */
const ASCII32_CHARS = '0123456789abcdefghijklmnopqrstuv'

/** 6 bit 符号表：数字 + 大小写字母 + `-` `_`，共 64 个；不含引号/括号，编辑器不会自动闭合。 */
const ASCII64_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

/** 4 bit 符号表：十六进制（诊断兜底，最抗干扰）。 */
const HEX_CHARS = '0123456789ABCDEF'

/**
 * @description 由字符集构造符号表
 * @param id 符号表标识
 * @param chars 等长字符集（长度必须是 2 的幂）
 * @param bits 每字符比特数
 * @returns 符号表
 */
function fromChars(id: AlphabetId, chars: string, bits: number): Alphabet {
  const table: number[] = []
  const index = new Map<number, number>()
  for (let position = 0; position < chars.length; position++) {
    const code = chars.charCodeAt(position)
    table.push(code)
    index.set(code, position)
  }
  return { id, bits, table, index }
}

/**
 * @description 构造 15 bit 的 CJK 符号表
 * @returns 符号表
 */
let ascii32: Alphabet | null = null
let ascii64: Alphabet | null = null
let hex: Alphabet | null = null

/**
 * @description 取符号表（惰性构造并缓存）
 * @param id 符号表标识
 * @returns 符号表
 */
export function getAlphabet(id: AlphabetId): Alphabet {
  if (id === 'ascii32') return (ascii32 ??= fromChars('ascii32', ASCII32_CHARS, 5))
  if (id === 'ascii64') return (ascii64 ??= fromChars('ascii64', ASCII64_CHARS, 6))
  return (hex ??= fromChars('hex', HEX_CHARS, 4))
}

/**
 * @description 判断取值是否为受支持的符号表标识
 * @param value 待判断的值
 * @returns 是否为 AlphabetId
 */
export function isAlphabetId(value: unknown): value is AlphabetId {
  return value === 'ascii32' || value === 'ascii64' || value === 'hex'
}

/**
 * @description 给定字节数需要的符号数（末组不足一个符号时补零填满）
 * @param bytes 字节数
 * @param id 符号表标识
 * @returns 符号数
 */
export function symbolCount(bytes: number, id: AlphabetId): number {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new CodecError(`字节数不合法：${String(bytes)}`)
  }
  const { bits } = getAlphabet(id)
  return bytes === 0 ? 0 : Math.ceil((bytes * 8) / bits)
}

/**
 * @description 字节序列 → 符号串。位流按大端取整组，末组右侧补零（接收端只取声明的前 `bytes` 个字节，补位内容不影响结果）
 * @param bytes 原始字节
 * @param id 符号表标识
 * @returns 符号串（只含符号表里的字符）
 */
export function encodeSymbols(bytes: Uint8Array, id: AlphabetId): string {
  const alphabet = getAlphabet(id)
  const { bits, table } = alphabet
  const mask = (1 << bits) - 1
  const out: string[] = []
  let accumulator = 0
  let accumulated = 0

  for (let position = 0; position < bytes.length; position++) {
    accumulator = (accumulator << 8) | bytes[position]
    accumulated += 8
    while (accumulated >= bits) {
      accumulated -= bits
      out.push(String.fromCharCode(table[(accumulator >>> accumulated) & mask]))
    }
    // 清掉已消费的高位，避免累加器无限增长（bits <= 15，accumulated < 15）
    accumulator &= (1 << accumulated) - 1
  }

  if (accumulated > 0) {
    out.push(String.fromCharCode(table[(accumulator << (bits - accumulated)) & mask]))
  }

  return out.join('')
}

/**
 * @description 符号串 → 字节序列，并严格校验：
 * 符号数量必须与 `bytes` 匹配、不能有表外字符、末组补位必须为 0。
 * 严格校验是必须的——「看起来像但其实是噪声」的内容如果被尽力解出，会写出坏数据。
 * @param text 符号串
 * @param id 符号表标识
 * @param bytes 期望的字节数
 * @returns 解出的字节
 */
export function decodeSymbols(text: string, id: AlphabetId, bytes: number): Uint8Array {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new CodecError(`字节数不合法：${String(bytes)}`)
  }
  const alphabet = getAlphabet(id)
  const { bits, index } = alphabet
  const expected = symbolCount(bytes, id)
  if (text.length !== expected) {
    throw new CodecError(
      `载荷长度不符：期望 ${expected} 个字符，实际 ${text.length}`,
      '片可能被截断或混入了多余字符'
    )
  }

  const out = new Uint8Array(bytes)
  let accumulator = 0
  let accumulated = 0
  let written = 0

  for (let position = 0; position < text.length; position++) {
    const symbol = index.get(text.charCodeAt(position))
    if (symbol === undefined) {
      throw new CodecError(`载荷含符号表之外的字符（第 ${position + 1} 个）`)
    }
    accumulator = (accumulator << bits) | symbol
    accumulated += bits
    while (accumulated >= 8 && written < bytes) {
      accumulated -= 8
      out[written] = (accumulator >>> accumulated) & 0xff
      written += 1
    }
    accumulator &= (1 << accumulated) - 1
  }

  if (written !== bytes) {
    throw new CodecError(`载荷不足以还原 ${bytes} 字节（只还原了 ${written} 字节）`)
  }
  if (accumulated > 0 && accumulator !== 0) {
    throw new CodecError('载荷末组补位不为零（数据被改写或符号表不匹配）')
  }
  return out
}
