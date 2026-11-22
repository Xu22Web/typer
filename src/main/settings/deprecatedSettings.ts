/**
 * 已废弃设置项的过渡提示：读配置时对照规则表，命中就写一条 warn 说明"按默认值运行"，
 * 随后由 `normalizeSettings` 归一化（读入不写回磁盘，下次保存才落盘）。
 *
 * 维护约定见 `.github/copilot-instructions.md`（要点：规则随版本删除，不当长期兼容层用）。
 */

/** 一条废弃设置的迁移规则 */
export interface DeprecatedSettingRule {
  /** 设置项路径（点分，例如 `transfer.paceMode`） */
  path: string
  /** 已废弃的取值；命中其中之一才提示（命中后由 normalize 回退默认值） */
  legacyValues: readonly unknown[]
  /** 写进日志的一句话，说明现在的行为 */
  hint: string
  /** 计划移除该提示的版本；到版本后删掉这条规则 */
  removeIn: string
}

/**
 * 当前生效的废弃规则。
 *
 * 已移除：文件传输的「极速」节奏档（字符 0ms + 整帧攒批）。
 * 移除原因：目标端输入队列被灌满后 `SendInput` 会阻塞，中途停止要等队列排空才恢复。
 */
export const DEPRECATED_SETTING_RULES: readonly DeprecatedSettingRule[] = [
  {
    path: 'transfer.paceMode',
    legacyValues: ['turbo'],
    hint: '原有的「极速」传输节奏已移除，本次按「稳健」运行（可在设置里改成「快速」）',
    removeIn: '0.3.0'
  }
]

/**
 * @description 按点分路径读取配置里的值
 * @param source 解析后的配置对象
 * @param path 点分路径
 * @returns 该路径上的值；路径不存在时返回 undefined
 */
function readPath(source: unknown, path: string): unknown {
  let cursor: unknown = source
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor
}

/**
 * @description 找出本次读取的配置里命中的废弃设置提示
 * @param source 解析后的配置对象（可能是任意 JSON）
 * @returns 去重后的提示文案列表；没有命中时为空数组
 */
export function collectDeprecatedSettingHints(source: unknown): string[] {
  if (typeof source !== 'object' || source === null) return []
  const hints = new Set<string>()
  for (const rule of DEPRECATED_SETTING_RULES) {
    const value = readPath(source, rule.path)
    if (rule.legacyValues.includes(value)) hints.add(rule.hint)
  }
  return [...hints]
}
