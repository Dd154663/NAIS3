/**
 * Drive 연결 컨트롤러 — 메인 스레드 (P6).
 *
 * GIS(gdrive-auth.ts) 토큰 발급과 워커(gdrive.ts) REST 호출을 잇는 얇은 계층.
 * - connect/disconnect: 사용자 제스처 (P6-5 플로팅 패널의 버튼이 호출)
 *
 * 토큰 발급(requestAccessToken)은 반드시 사용자 제스처에서만 한다 — GIS는 항상 팝업을 열고,
 * 팝업은 클릭 없이 차단되기 때문. GIS는 리프레시 토큰이 없어 무팝업 재발급도 불가하다.
 * 세션 간 지속은 발급된 액세스 토큰(수명 ~1h)을 저장해 만료 전 재사용하는 방식으로만 가능하다
 * (drive-token-store.ts). 만료 후엔 워커가 큐에 쌓고 패널이 "재연결 필요"를 노출한다.
 */
import { rpcInvoke } from './backend/ipc'
import {
  isDriveConfigured,
  requestDriveToken,
  revokeDriveToken
} from './backend/gdrive-auth'
import { clearDriveToken, readDriveToken, saveDriveToken } from './drive-token-store'

export { isDriveConfigured }

export interface GDriveStatus {
  enabled: boolean
  hasToken: boolean
  queueLength: number
  cacheLimit: number
}

/** 최초 연결 — 동의 팝업 → 토큰을 저장하고 워커에 주입 */
export async function connectDrive(): Promise<{ hasToken: boolean }> {
  const token = await requestDriveToken(true)
  saveDriveToken(token) // 만료 전 새로고침·재시작에서 재사용
  return rpcInvoke<{ hasToken: boolean }>('_gdrive:setToken', token)
}

/**
 * 부팅 세션 복원 — 저장된 액세스 토큰이 아직 유효하면(만료 전) GIS 재호출·팝업 없이 워커에
 * 그대로 주입한다. 새로고침·재시작이 토큰 수명(~1h) 안이면 클릭 없이 즉시 재연결된다.
 * 만료됐거나 저장분이 없으면 정리 후 false를 반환해 패널이 "재연결 필요"를 표시한다.
 * 부팅을 막지 않도록 fire-and-forget로 호출한다.
 * @returns 세션 복원(즉시 재연결) 성공 여부
 */
export async function restoreDriveSession(): Promise<boolean> {
  if (!isDriveConfigured()) return false
  const stored = readDriveToken()
  if (!stored) return false
  if (Date.now() >= stored.expiresAt - 60_000) {
    clearDriveToken() // 만료 — 다음 재연결 때까지 정리 (워커의 hasDriveToken도 같은 60s 여유)
    return false
  }
  try {
    const res = await rpcInvoke<{ hasToken: boolean }>('_gdrive:setToken', stored)
    return res.hasToken
  } catch {
    return false
  }
}

/** 연결 해제 — 저장 토큰 제거 + 폐기 + 워커 상태 초기화 */
export async function disconnectDrive(): Promise<void> {
  clearDriveToken()
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
