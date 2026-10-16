import type { TimingSettings } from './timing'

export interface TimingPreset {
  id: 'uniform' | 'human' | 'fast' | 'slow'
  label: string
  /** 只覆盖节奏相关字段，其余保持用户当前设置。 */
  patch: Partial<TimingSettings>
}

/** 常用节奏预设，供设置界面一键切换。 */
export const TIMING_PRESETS: readonly TimingPreset[] = [
  {
    id: 'uniform',
    label: '匀速（无随机）',
    patch: {
      speedMode: 'cps',
      cps: 8,
      jitterMs: 0,
      distribution: 'uniform',
      wordPauseMs: 0,
      punctuationPauseMs: 0,
      newlinePauseMs: 0,
      paragraphPauseMs: 0,
      burstSize: 0
    }
  },
  {
    id: 'human',
    label: '拟人（推荐）',
    patch: {
      speedMode: 'cps',
      cps: 6,
      jitterMs: 25,
      distribution: 'gaussian',
      wordPauseMs: 0,
      punctuationPauseMs: 120,
      newlinePauseMs: 250,
      paragraphPauseMs: 600,
      burstSize: 40,
      burstPauseMs: 400
    }
  },
  {
    id: 'fast',
    label: '快速',
    patch: {
      speedMode: 'cps',
      cps: 20,
      jitterMs: 8,
      distribution: 'uniform',
      punctuationPauseMs: 20,
      newlinePauseMs: 60,
      paragraphPauseMs: 120,
      burstSize: 0
    }
  },
  {
    id: 'slow',
    label: '慢速（演示）',
    patch: {
      speedMode: 'cps',
      cps: 2,
      jitterMs: 60,
      distribution: 'gaussian',
      punctuationPauseMs: 300,
      newlinePauseMs: 500,
      paragraphPauseMs: 1000,
      burstSize: 20,
      burstPauseMs: 800
    }
  }
]

/**
 * @description 按 id 取节奏预设
 * @param id 预设 id
 * @returns 预设；未知 id 时为 undefined
 */
export function getTimingPreset(id: TimingPreset['id']): TimingPreset | undefined {
  return TIMING_PRESETS.find((preset) => preset.id === id)
}
