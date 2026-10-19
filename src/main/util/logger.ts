import { spawnSync } from 'node:child_process'
import iconv from 'iconv-lite'

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

export interface Logger {
  error(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  debug(message: string, ...rest: unknown[]): void
  child(scope: string): Logger
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
}

export interface LoggerOptions {
  level?: LogLevel
  /** 额外接收日志行（例如写入文件或推送到界面） */
  sink?: (level: LogLevel, scope: string, message: string) => void
  scope?: string
}

/**
 * @description 建立分级日志器；输入内容默认不进日志（只允许记录长度等元信息），这是隐私设置的一部分而不是顺手的约定
 * @param options 初始级别、额外日志接收器与作用域
 * @returns 日志器（另带非枚举的 setLevel）
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  let level = options.level ?? 'info'
  const scope = options.scope ?? 'Typer'

  /**
   * @description 低于当前级别的日志直接丢弃；有 sink 时交给 sink，否则打到控制台
   * @param target 该条日志的级别
   * @param message 日志正文
   * @param rest 附加上下文
   */
  const write = (target: LogLevel, message: string, rest: unknown[]): void => {
    if (LEVEL_WEIGHT[target] > LEVEL_WEIGHT[level]) return
    const line = rest.length > 0 ? `${message} ${rest.map(stringify).join(' ')}` : message
    options.sink?.(target, scope, line)
    if (options.sink) return
    writeConsole(target === 'error' || target === 'warn' ? 'err' : 'out', `[${scope}] ${line}`)
  }

  const logger: Logger = {
    error: (message, ...rest) => write('error', message, rest),
    warn: (message, ...rest) => write('warn', message, rest),
    info: (message, ...rest) => write('info', message, rest),
    debug: (message, ...rest) => write('debug', message, rest),
    child: (childScope) =>
      createLogger({
        level,
        sink: options.sink,
        scope: `${scope}:${childScope}`
      })
  }

  Object.defineProperty(logger, 'setLevel', {
    value: (next: LogLevel) => {
      level = next
    },
    enumerable: false
  })

  return logger
}

/**
 * @description 把附加上下文转成可读文本（对象走 JSON，循环引用等异常时退回 String）
 * @param value 任意值
 * @returns 文本
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 缓存的转码编码：undefined 表示还没探测过，null 表示不需要转码
 */
let consoleEncoding: string | null | undefined

/**
 * @description 探测当前控制台代码页对应的编码。
 * Windows 控制台按「输出代码页」解释写入的字节，默认是 936（GBK），而 Node 写出的是 UTF-8，
 * 中文于是被当成 GBK 解码成「鍏ㄥ眬鐑敭」这类乱码，因此这里按控制台代码页回编码后再写。
 * 只在 Windows + 真实终端下转码：管道/重定向时字节原样透传，保持 UTF-8 才是对的。
 * @returns iconv 编码名，null 表示沿用 console 默认行为
 */
function detectConsoleEncoding(): string | null {
  if (consoleEncoding !== undefined) return consoleEncoding
  consoleEncoding = null
  if (process.platform !== 'win32') return consoleEncoding
  // chcp 的提示文案随系统语言变化，所以只从输出里提取数字部分
  const result = spawnSync('chcp.com', [], { windowsHide: true })
  // 没有关联控制台时 chcp 会失败；这种场景输出是文件/管道，保持 UTF-8 才对
  if (result.error || result.status !== 0 || !result.stdout) return consoleEncoding
  const match = /(\d{3,5})/.exec(result.stdout.toString('latin1'))
  const codePage = match ? Number(match[1]) : 65001
  const encoding = `cp${codePage}`
  if (codePage !== 65001 && iconv.encodingExists(encoding)) consoleEncoding = encoding
  return consoleEncoding
}

/**
 * @description 输出一行日志；需要转码时按字节写流，不需要时交回 console 以保留其原有行为
 * @param target 写入 stdout（out）还是 stderr（err）
 * @param text 完整日志行（已含作用域前缀）
 */
function writeConsole(target: 'out' | 'err', text: string): void {
  const encoding = detectConsoleEncoding()
  if (encoding === null) {
    if (target === 'err') console.error(text)
    else console.log(text)
    return
  }
  const stream = target === 'err' ? process.stderr : process.stdout
  stream.write(iconv.encode(`${text}\n`, encoding))
}

/**
 * @description 建立什么都不输出的日志器（测试默认使用）
 * @returns 静默日志器
 */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' })
}
