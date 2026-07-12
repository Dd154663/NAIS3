/**
 * Drive 연결 컨트롤러 — 메인 스레드 (P6).
 *
 * GIS(gdrive-auth.ts) 토큰 발급과 워커(gdrive.ts) REST 호출을 잇는 얇은 계층.
 * - connect/disconnect: 사용자 제스처 (P6-5 플로팅 패널의 버튼이 호출)
 *
 * 토큰 발급은 반드시 사용자 제스처에서만 한다 — GIS는 항상 팝업이 필요하고, 팝업은 클릭 없이
 * 차단되기 때문. 부팅 자동 재연결이나 만료 시 자동 재발급(무팝업)은 GIS에 존재하지 않으므로
 * 시도하지 않는다. 토큰이 없으면 워커가 큐에 쌓아두고, 패널이 상태로 "재연결 필요"를 노출한다.
 */
import { rpcInvoke } from './backend/ipc'
import { isDriveConfigured, requestDriveToken, revokeDriveToken } from './backend/gdrive-auth'

export { isDriveConfigured }

export interface GDriveStatus {
  enabled: boolean
  hasToken: boolean
  queueLength: number
  cacheLimit: number
}

/** 최초 연결 — 동의 팝업 → 토큰을 워커에 주입 */
export async function connectDrive(): Promise<{ hasToken: boolean }> {
  const token = await requestDriveToken(true)
  return rpcInvoke<{ hasToken: boolean }>('_gdrive:setToken', token)
}

/** 연결 해제 — 토큰 폐기 + 워커 상태 초기화 */
export async function disconnectDrive(): Promise<void> {
  revokeDriveToken()
  await rpcInvoke('_gdrive:clearToken')
}

export function gdriveStatus(): Promise<GDriveStatus> {
  return rpcInvoke<GDriveStatus>('_gdrive:status')
}

/** 대기열 수동 재시도 (패널 버튼) */
export function drainDrive(): Promise<{ done: number; left: number }> {
  return rpcInvoke<{ done: number; left: number }>('_gdrive:drain')
}

/** 로컬 보관 매수 변경 (패널 설정) */
export function setDriveCacheLimit(limit: number): Promise<{ cacheLimit: number }> {
  return rpcInvoke<{ cacheLimit: number }>('_gdrive:setCacheLimit', { limit })
}
