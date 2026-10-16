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
    const prefix = `[${scope}]`
    if (target === 'error') console.error(prefix, line)
    else if (target === 'warn') console.warn(prefix, line)
    else console.log(prefix, line)
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
 * @description 建立什么都不输出的日志器（测试默认使用）
 * @returns 静默日志器
 */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' })
}
