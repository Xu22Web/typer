/**
 * 进度输出层：只负责"把这些行写到终端上"，不关心行里写的是什么。
 *
 * 三种模式：
 *   · `block`——两行原地重绘（光标上移 + 擦除）。终端不支持 ANSI/VT 时**不能**用，
 *     否则转义序列会被原样打印出来；
 *   · `row`  ——单行原地重绘（只依赖 `\r`，老式 conhost 也能用）；
 *   · `plain`——重定向到日志/管道时的逐行输出，按间隔节流，绝不出现 `\r` 与转义序列。
 *
 * 三条不变量（旧版"有时原地、有时狂刷屏"就是这里破掉的）：
 *   1. 每行宽度由排版层裁到终端宽度以内，**永不折行**（折行会让光标上移错位）；
 *   2. 只有两种输出：进度块，或"清掉进度块 + 一整行日志"，不会出现半截拼接；
 *   3. 节流按模式区分：原地重绘要够快才看得见变化，写日志要够慢才不刷屏。
 */
import { displayWidth, paintSegments, plainText, type Segment } from './text'

/** 输出模式 */
export type ScreenMode = 'block' | 'row' | 'plain'

/** 终端能力（由 console 模块探测，测试可直接构造） */
export interface ScreenCaps {
  /** 标准输出是不是终端 */
  tty: boolean
  /** 是否支持 ANSI（光标上移、清屏、颜色） */
  vt: boolean
  /** 终端列数 */
  columns: number
  /** 是否可用方块字符 / 盲文转圈 */
  unicode: boolean
  /** 是否上色 */
  color: boolean
}

/** 原地重绘的最小间隔：再快人眼也看不出来，反而抢终端带宽（云桌面回传很慢） */
const INLINE_INTERVAL_MS = 300

/** 逐行写日志的最小间隔：写进日志文件时 5 秒一行足够看出趋势 */
const PLAIN_INTERVAL_MS = 5_000

/**
 * 屏幕对象：把排版好的行写到终端，并在"下一次写日志"前先清掉进度块
 */
export class Screen {
  private blockRows = 0
  private lastRowWidth = 0
  private lastPlainText = ''
  private lastDrawAt = 0

  constructor(
    private readonly caps: ScreenCaps,
    readonly mode: ScreenMode,
    private readonly write: (text: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * @description 画进度
   * @param rows 已裁好的行
   * @param force 忽略节流立即重画（阶段切换、收齐、合并最后一片时用）
   * @returns 是否真的写了
   */
  draw(rows: Segment[][], force = false): boolean {
    if (rows.length === 0) return false
    const now = this.now()
    const interval = this.mode === 'plain' ? PLAIN_INTERVAL_MS : INLINE_INTERVAL_MS
    if (!force && now - this.lastDrawAt < interval) return false
    this.lastDrawAt = now

    if (this.mode === 'plain') {
      const text = rows
        .map((row) => plainText(row))
        .filter((line) => line.length > 0)
        .join('  ')
      if (!force && text === this.lastPlainText) return false
      this.lastPlainText = text
      this.write(`${text}\n`)
      return true
    }

    const lines = rows.map((row) => paintSegments(row, this.caps.color))
    if (this.mode === 'row') {
      this.drawRow(lines.join('  '))
      return true
    }
    this.drawBlock(lines)
    return true
  }

  /**
   * @description 输出一整行普通信息（进度块会先被清掉，避免文字接在进度行尾巴上）
   * @param text 一整行文本（可带颜色，调用方自己 paint）
   */
  log(text: string): void {
    this.clearProgress()
    this.write(text.endsWith('\n') ? text : `${text}\n`)
  }

  /** @description 清掉进度块；进程退出前必须调用，否则提示符会接在进度行后面 */
  clear(): void {
    this.clearProgress()
  }

  /**
   * @description 忘了当前进度块的几何信息。
   *
   * 终端被 resize 后原来"块有几行"的假设不再可靠（行可能被重新折行），
   * 此时继续上移光标只会把界面搅乱——直接放弃上移，新的一帧当作全新块来画。
   */
  forget(): void {
    this.blockRows = 0
    this.lastRowWidth = 0
    this.lastPlainText = ''
  }

  /** @description 单行原地重绘：`\r` + 内容 + 补空格盖掉上一次的残留 */
  private drawRow(line: string): void {
    const width = displayWidth(stripColor(line))
    const pad = width >= this.lastRowWidth ? '' : ' '.repeat(this.lastRowWidth - width)
    this.write(`\r${line}${pad}`)
    this.lastRowWidth = width
  }

  /** @description 多行原地重绘：上移 → 擦掉整块 → 重画 */
  private drawBlock(lines: string[]): void {
    const parts: string[] = []
    if (this.blockRows > 0 && this.caps.vt) parts.push(`\u001b[${this.blockRows}A`)
    parts.push('\r\u001b[J')
    parts.push(`${lines.join('\n')}\n`)
    this.write(parts.join(''))
    this.blockRows = lines.length
  }

  /** @description 清掉进度块，让后续输出从干净的一行开始 */
  private clearProgress(): void {
    if (this.mode === 'plain') {
      this.lastPlainText = ''
      return
    }
    if (this.mode === 'row') {
      if (this.lastRowWidth > 0) this.write(`\r${' '.repeat(this.lastRowWidth)}\r`)
      this.lastRowWidth = 0
      return
    }
    if (this.blockRows > 0 && this.caps.vt) {
      this.write(`\u001b[${this.blockRows}A\r\u001b[J`)
    }
    this.blockRows = 0
  }
}

/** @description 估一行上色文本的可见宽度（`paintSegments` 的逆运算，只用于补空格） */
function stripColor(text: string): string {
  // eslint-disable-next-line no-control-regex -- 要剥掉的就是 ESC 序列本身
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}
