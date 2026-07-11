import type { UcPresetIndex } from '@shared/types'

export const SAMPLERS = [
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM' }
] as const

export const NOISE_SCHEDULES = [
  { value: 'karras', label: 'Karras' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' }
] as const

export const RESOLUTIONS = [
  { label: '세로 (832×1216)', width: 832, height: 1216 },
  { label: '가로 (1216×832)', width: 1216, height: 832 },
  { label: '정사각 (1024×1024)', width: 1024, height: 1024 },
  { label: '세로 대형 (1024×1536)', width: 1024, height: 1536 },
  { label: '가로 대형 (1536×1024)', width: 1536, height: 1024 }
] as const

/** 실캡처 확정 매핑 — 2는 미사용이라 UI에 노출하지 않는다 */
export const UC_PRESET_OPTIONS: { value: UcPresetIndex; label: string }[] = [
  { value: 0, label: 'Heavy' },
  { value: 1, label: 'Light' },
  { value: 3, label: 'Human Focus' },
  { value: 4, label: 'None' }
]

export function imageUrl(filePath: string): string {
  // 플랫폼이 자체 URL 스킴을 제공하면 그것을 (웹 빌드 등), 아니면 Electron 프로토콜
  return window.nais.imageUrl?.(filePath) ?? `nais-image://local/?path=${encodeURIComponent(filePath)}`
}
