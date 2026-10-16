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

/** 把某个节奏预设应用到设置上。 */
export function applyTimingPreset(settings: Settings, presetId: string): Settings {
  const preset = TIMING_PRESETS.find((item) => item.id === presetId)
  if (!preset) return settings
  return mergeSettings(settings, { timing: preset.patch })
}
