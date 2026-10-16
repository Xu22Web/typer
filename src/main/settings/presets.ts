import { TIMING_PRESETS } from '../typing/scheduling/presets'
import { mergeSettings, type Settings } from './schema'

export { TIMING_PRESETS }
export type { TimingPreset } from '../typing/scheduling/presets'

export interface SettingsPreset {
  id: string
  label: string
  description: string
}

/** 供设置界面展示的预设列表（实际补丁来自 TIMING_PRESETS）。 */
export const SETTINGS_PRESETS: readonly SettingsPreset[] = TIMING_PRESETS.map((preset) => ({
  id: preset.id,
  label: preset.label,
  description: describePreset(preset.id)
}))

/**
 * @description 给出预设的中文说明（预设本身只带 id 与标签）
 * @param id 预设 id
 * @returns 说明文本（未知 id 返回空串）
 */
function describePreset(id: string): string {
  switch (id) {
    case 'uniform':
      return '固定间隔、无随机抖动，适合需要稳定节奏的场景'
    case 'human':
      return '高斯抖动 + 标点/换行停顿 + 周期性停顿，最接近真人'
    case 'fast':
      return '快速输入，抖动很小'
    case 'slow':
      return '慢速演示，停顿明显'
    default:
      return ''
  }
}

/**
 * @description 把某个节奏预设的补丁合并进设置
 * @param settings 当前设置
 * @param presetId 预设 id
 * @returns 合并后的设置（id 未知时原样返回）
 */
export function applyTimingPreset(settings: Settings, presetId: string): Settings {
  const preset = TIMING_PRESETS.find((item) => item.id === presetId)
  if (!preset) return settings
  return mergeSettings(settings, { timing: preset.patch })
}
