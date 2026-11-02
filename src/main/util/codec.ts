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
// 只用 node: 内置模块、零第三方依赖，Node >= 14 可运行（接收端脚本可能跑在老机器的 Node 14 上）；
// 主进程与接收端脚本共用这一份实现。源码可以用较新的语法，接收端产物由 esbuild 按 node14 目标自动降级。

/** 载荷符号表标识（写进开始帧的 `alpha` 字段）。 */
export type AlphabetId = 'ascii32' | 'ascii64' | 'hex' | 'b47'

/**
 * 符号表。两种编码方式：
 *   · `bits`  —— 位打包，每字符固定 `bits` 位（只支持 2 的幂）；
 *   · `radix` —— 分块基数转换：把每 {@link RADIX_BLOCK_BYTES} 字节当成一个大整数换成 `radix` 进制。
 *
 * 为什么需要第二种：位打包要求字符集大小是 2 的幂，而"美式布局上无需 Shift 的可打印键"有 47 个，
 * 只用 32 个白扔了 0.55 bit/字符（≈8% 的字符数）。基数转换不受这个限制。
 */
export interface Alphabet {
  id: AlphabetId
  kind: 'bits' | 'radix'
  /** 每个字符承载的比特数（`radix` 表这里是理论值 log2(radix)；估算请用 `symbolsForBytes`） */
  bits: number
  /** 进制：位打包表为 2^bits */
  radix: number
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

/** 4 bit 符号表：Hex（诊断兜底，最抗干扰）。 */
const HEX_CHARS = '0123456789ABCDEF'

/**
 * 47 键符号表：美式布局上**全部无需 Shift 的可打印键**（不含空格，也不含 `@`——它是帧标记）。
 *
 * 36 个字母数字 + `` ` - = [ ] \ ; ' , . / `` 共 47 个：log2(47) = 5.554 bit/字符，
 * 分块后实际 5.447（每 32 字节用 47 个字符），比 ascii32 少约 8% 字符。
 *
 * **只用于终端**：编辑器会把 `--`、`1/2`、`...` 自动更正成 `—`/`½`/`…`，`' [ ] `` ` `` 还会自动闭合，
 * 这些都会直接改写载荷（接收端的整文件哈希能发现，但那一刻已经白打了）。
 */
const B47_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz`-=[]\\;' + "'" + ',./'

/**
 * @description 由字符集构造符号表
 * @param id 符号表标识
 * @param chars 字符集（位打包表长度必须是 2 的幂）
 * @param bits 每字符理论比特数
 * @returns 符号表
 */
function fromChars(id: AlphabetId, chars: string, bits: number): Alphabet {
  const table: number[] = []
  const index = new Map<number, number>()
  for (let position = 0; position < chars.length; position++) {
    const code = chars.charCodeAt(position)
    if (index.has(code)) throw new CodecError(`符号表 ${id} 里有重复字符`)
    table.push(code)
    index.set(code, position)
  }
  const radix = chars.length
  const kind = (radix & (radix - 1)) === 0 ? 'bits' : 'radix'
  if (kind === 'bits' && radix !== 1 << bits) {
    throw new CodecError(`符号表 ${id} 的长度与位宽不一致`)
  }
  return { id, kind, bits, radix, table, index }
}

/** 分块基数编码的块大小（字节）：32 字节 = 256 bit，一次 BigInt 除法就够便宜 */
export const RADIX_BLOCK_BYTES = 32

/** 每个基数符号表"字节长度 → 字符数"的查表（长度 0..RADIX_BLOCK_BYTES） */
const digitTables = new Map<AlphabetId, number[]>()

/**
 * @description 一个块（≤ 32 字节）换成基数符号需要几个字符。
 *
 * 用整数幂校验而不是只靠 `ceil(8n/log2(radix))`：浮点误差会让某个长度少算一位，
 * 那是"偶尔写坏一个字节"的经典来源。
 * @param bytes 块内字节数
 * @param alphabet 基数符号表
 * @returns 字符数
 */
function blockDigits(bytes: number, alphabet: Alphabet): number {
  if (bytes <= 0) return 0
  let table = digitTables.get(alphabet.id)
  if (!table) {
    table = new Array<number>(RADIX_BLOCK_BYTES + 1).fill(0)
    const radix = BigInt(alphabet.radix)
    for (let length = 1; length <= RADIX_BLOCK_BYTES; length++) {
      const limit = 1n << BigInt(length * 8)
      let digits = Math.ceil((length * 8) / Math.log2(alphabet.radix))
      let power = radix ** BigInt(digits)
      while (power < limit) {
        digits += 1
        power *= radix
      }
      table[length] = digits
    }
    digitTables.set(alphabet.id, table)
  }
  return table[bytes] as number
}

let ascii32: Alphabet | null = null
let ascii64: Alphabet | null = null
let hex: Alphabet | null = null
let b47: Alphabet | null = null

/**
 * @description 取符号表（惰性构造并缓存）
 * @param id 符号表标识
 * @returns 符号表
 */
export function getAlphabet(id: AlphabetId): Alphabet {
  if (id === 'ascii32') return (ascii32 ??= fromChars('ascii32', ASCII32_CHARS, 5))
  if (id === 'ascii64') return (ascii64 ??= fromChars('ascii64', ASCII64_CHARS, 6))
  if (id === 'b47') return (b47 ??= fromChars('b47', B47_CHARS, Math.log2(B47_CHARS.length)))
  return (hex ??= fromChars('hex', HEX_CHARS, 4))
}

/**
 * @description 判断取值是否为受支持的符号表标识
 * @param value 待判断的值
 * @returns 是否为 AlphabetId
 */
export function isAlphabetId(value: unknown): value is AlphabetId {
  return value === 'ascii32' || value === 'ascii64' || value === 'hex' || value === 'b47'
}

/**
 * @description 每个符号平均承载的比特数（位打包表是精确值；基数表按分块后的实际值算）
 * @param id 符号表标识
 * @returns 比特/字符
 */
export function bitsPerSymbol(id: AlphabetId): number {
  const alphabet = getAlphabet(id)
  if (alphabet.kind === 'bits') return alphabet.bits
  return (RADIX_BLOCK_BYTES * 8) / blockDigits(RADIX_BLOCK_BYTES, alphabet)
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
  if (bytes === 0) return 0
  const alphabet = getAlphabet(id)
  if (alphabet.kind === 'bits') return Math.ceil((bytes * 8) / alphabet.bits)
  const full = Math.floor(bytes / RADIX_BLOCK_BYTES)
  const rest = bytes % RADIX_BLOCK_BYTES
  return full * blockDigits(RADIX_BLOCK_BYTES, alphabet) + blockDigits(rest, alphabet)
}

/**
 * @description 字节序列 → 符号串。位流按大端取整组，末组右侧补零（接收端只取声明的前 `bytes` 个字节，补位内容不影响结果）
 * @param bytes 原始字节
 * @param id 符号表标识
 * @returns 符号串（只含符号表里的字符）
 */
export function encodeSymbols(bytes: Uint8Array, id: AlphabetId): string {
  const alphabet = getAlphabet(id)
  if (alphabet.kind === 'radix') return encodeRadix(bytes, alphabet)
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

  if (alphabet.kind === 'radix') return decodeRadix(text, alphabet, bytes)

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
/**
 * @description 分块基数编码：每 {@link RADIX_BLOCK_BYTES} 字节当成一个大整数换成 `radix` 进制。
 *
 * 末块按实际字节数定长，因此解码端不需要额外元信息（帧头里的 `bytes` 就够）。
 * @param bytes 原始字节
 * @param alphabet 基数符号表
 * @returns 符号串
 */
function encodeRadix(bytes: Uint8Array, alphabet: Alphabet): string {
  const { table } = alphabet
  const radix = BigInt(alphabet.radix)
  const out: string[] = []
  for (let offset = 0; offset < bytes.length; offset += RADIX_BLOCK_BYTES) {
    const length = Math.min(RADIX_BLOCK_BYTES, bytes.length - offset)
    let value = 0n
    for (let index = 0; index < length; index++) {
      value = (value << 8n) | BigInt(bytes[offset + index] as number)
    }
    const digits = blockDigits(length, alphabet)
    const chars: string[] = new Array<string>(digits)
    for (let index = digits - 1; index >= 0; index--) {
      chars[index] = String.fromCharCode(table[Number(value % radix)] as number)
      value /= radix
    }
    // 数学上必然为 0（位数已按整数幂校验过）；留着是为了实现走偏时当场报错，而不是写出坏数据
    if (value !== 0n) throw new CodecError('块内数值超出可编码范围')
    out.push(chars.join(''))
  }
  return out.join('')
}

/**
 * @description 分块基数解码：逐块把 radix 进制还原成字节，并校验每块数值不越过字节长度
 * @param text 符号串（长度已由调用方校验）
 * @param alphabet 基数符号表
 * @param bytes 期望字节数
 * @returns 原始字节
 */
function decodeRadix(text: string, alphabet: Alphabet, bytes: number): Uint8Array {
  const radix = BigInt(alphabet.radix)
  const { index } = alphabet
  const out = new Uint8Array(bytes)
  let cursor = 0
  let written = 0
  while (written < bytes) {
    const length = Math.min(RADIX_BLOCK_BYTES, bytes - written)
    const digits = blockDigits(length, alphabet)
    let value = 0n
    for (let offset = 0; offset < digits; offset++) {
      const symbol = index.get(text.charCodeAt(cursor + offset))
      if (symbol === undefined) {
        throw new CodecError(`载荷含符号表之外的字符（第 ${cursor + offset + 1} 个）`)
      }
      value = value * radix + BigInt(symbol)
    }
    cursor += digits
    // 越过本块字节能表示的范围 ⇒ 载荷被改写过（帧 CRC 之外的第二道防线）
    if (value >> BigInt(length * 8) !== 0n) {
      throw new CodecError('载荷块数值超出字节长度（数据被改写或符号表不匹配）')
    }
    for (let offset = length - 1; offset >= 0; offset--) {
      out[written + offset] = Number(value & 0xffn)
      value >>= 8n
    }
    written += length
  }
  return out
}
