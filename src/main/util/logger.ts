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
 * 极简分级日志。
 *
 * 注意：**输入内容默认不进日志**（只允许记录长度等元信息），
 * 这是隐私设置的一部分，不是"顺手"的约定。
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  let level = options.level ?? 'info'
  const scope = options.scope ?? 'Typer'

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

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 静默日志（测试默认使用）。 */
export function createSilentLogger(): Logger {
  return createLogger({ level: 'silent' })
}
