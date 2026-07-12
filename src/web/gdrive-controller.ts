/**
 * Drive 연결 컨트롤러 — 메인 스레드 (P6).
 *
 * GIS(gdrive-auth.ts) 토큰 발급과 워커(gdrive.ts) REST 호출을 잇는 얇은 계층.
 * - connect/disconnect: 사용자 동작 (P6-5 플로팅 패널이 호출)
 * - 브릿지: 워커가 토큰 만료로 `_gdrive:needToken`을 쏘면 무팝업 재발급해 다시 밀어넣는다
 */
import { subscribe } from './bus'
import { rpcInvoke } from './backend/ipc'
import { isDriveConfigured, requestDriveToken, revokeDriveToken } from './backend/gdrive-auth'

export { isDriveConfigured }

export interface GDriveStatus {
  enabled: boolean
  hasToken: boolean
  queueLength: number
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

let bridgeInstalled = false

/** 워커의 토큰 만료 알림 → 무팝업 재발급 → 재주입. bootstrap이 1회 설치 */
export function initGdriveBridge(): void {
  if (bridgeInstalled) return
  bridgeInstalled = true
  subscribe('_gdrive:needToken', () => {
    void (async () => {
      try {
        const token = await requestDriveToken(false)
        await rpcInvoke('_gdrive:setToken', token)
      } catch {
        // 무팝업 갱신 실패(세션 만료 등) — 다음 사용자 상호작용에서 재연결하게 둔다
      }
    })()
  })
}
