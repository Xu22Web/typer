/**
 * 把宿主记录下来的按键事件重放成"目标窗口收到的文本"。
 *
 * 为什么需要它：端到端测试跑在 dry-run 宿主上（不真的注入按键），但"引擎到底让宿主敲了什么"仍然
 * 是硬事实——宿主把每个真正会发出的事件（含修饰键的按下/抬起）按顺序记进文件，这里按真实键盘语义
 * 重放一遍，得到的字符串就是目标窗口本该收到的内容。用它可以直接把收到的文本与源文本逐字符比对，
 * 也能把文件传输的帧文本交给真正的接收端（tools/typer-recv.mjs）还原出文件。
 *
 * 这一层能抓到"修饰键顺序错/漏发"这类肉眼很难发现的回归：如果 Shift 的 down 排在主键之后，
 * `!` 就会重放成 `1`。
 */
import { LAYOUTS, VK } from '@main/typing/planner/keymap'

/** 一条记录下来的按键事件 */
export interface RecordedKeyEvent {
  vk: number
  up: boolean
}

/** 修饰键的虚拟键码（左右分身的 0xA0~0xA5 也一并算上） */
const MODIFIER_VKS = new Set([
  VK.SHIFT,
  VK.CONTROL,
  VK.ALT,
  VK.WIN,
  0xa0,
  0xa1,
  0xa2,
  0xa3,
  0xa4,
  0xa5
])

/** `vk + 修饰键` → 字符（US 布局；与引擎规划用的是同一张表） */
const US_REVERSE = new Map<string, string>(
  Object.entries(LAYOUTS.us.charMap).map(([char, key]) => [
    `${key.vk}+${[...key.modifiers].sort().join(',')}`,
    char
  ])
)

/**
 * @description 解析宿主记录文件的内容（每行 `vk,up`；`#` 开头的是请求分隔标记）
 * @param lines 文件里的非空行
 * @returns 按发送顺序排列的事件
 */
export function parseRecordedEvents(lines: string[]): RecordedKeyEvent[] {
  return lines
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => {
      const [vkText, upText] = line.trim().split(',')
      const vk = Number(vkText)
      if (!Number.isInteger(vk)) throw new Error(`按键记录格式不对：「${line}」`)
      return { vk, up: upText === '1' }
    })
}

/**
 * @description 按真实键盘语义重放事件流，得到目标窗口会收到的文本
 * @param events 记录下来的按键事件
 * @returns 重放得到的文本（回车为 `\n`，Tab 为 `\t`，退格会删掉上一个字符）
 */
export function replayAsText(events: RecordedKeyEvent[]): string {
  const held = new Set<number>()
  const out: string[] = []

  for (let index = 0; index < events.length; index++) {
    const event = events[index] as RecordedKeyEvent
    if (MODIFIER_VKS.has(event.vk)) {
      if (event.up) held.delete(event.vk)
      else held.add(event.vk)
      continue
    }
    // 主键抬起不产生字符
    if (event.up) continue

    if (event.vk === VK.ENTER) {
      out.push('\n')
      continue
    }
    if (event.vk === VK.TAB) {
      out.push('\t')
      continue
    }
    if (event.vk === VK.BACKSPACE) {
      out.pop()
      continue
    }
    if (event.vk === VK.HOME || event.vk === VK.END) {
      throw new Error(
        '录制里出现了 Home/End：重放器不建模"选中并覆盖"的语义，请在本用例里把「行首归位」设为不处理'
      )
    }

    const modifiers = held.has(VK.SHIFT) ? 'shift' : ''
    const char = US_REVERSE.get(`${event.vk}+${modifiers}`)
    if (char === undefined) {
      const context = events
        .slice(0, Math.min(events.length, index + 2))
        .map((item) => `${item.vk}${item.up ? '↑' : '↓'}`)
        .join(' ')
      throw new Error(
        `录制里出现了无法还原的按键：第 ${index} 个事件 vk=${event.vk} shift=${modifiers === 'shift'}（上下文：${context}）`
      )
    }
    out.push(char)
  }

  return out.join('')
}
