/**
 * Drive 액세스 토큰 지속 (연동 편의성) — 메인 스레드 전용.
 *
 * GIS 토큰 모델은 리프레시 토큰이 없고, 부팅 시 무팝업 재발급도 불가하다
 * (requestAccessToken은 prompt:''라도 팝업을 열어, 사용자 제스처 없는 부팅에선 차단됨).
 * 그래서 발급받은 액세스 토큰(수명 ~1시간)을 그대로 localStorage에 담아, 만료 전
 * 새로고침·재시작에서는 재발급 없이 그대로 재사용한다. 만료 후에는 패널에서 한 번 재연결.
 *
 * 토큰은 drive.file 스코프의 단기(1h) 베어러라 저장 위험이 낮다 — NAI 토큰과 동일한
 * 보안 수준(사이트 데이터 삭제 시 함께 소멸). 리프레시 토큰이 아니므로 장기 노출도 없다.
 */
import type { DriveToken } from './backend/gdrive-auth'

const KEY = 'nais3_drive_token'

/** 토큰 발급/재연결 성공 시 저장 */
export function saveDriveToken(t: DriveToken): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    // localStorage 불가 — 저장 없이도 이번 세션 연결은 동작한다
  }
}

/** 부팅 복원용 — 저장된 토큰(형식 불량/없음이면 null). 만료 판정은 호출측에서 */
export function readDriveToken(): DriveToken | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as DriveToken
    if (typeof t?.token !== 'string' || typeof t?.expiresAt !== 'number') return null
    return t
  } catch {
    return null
  }
}

/** 연결 해제/만료 시 제거 */
export function clearDriveToken(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // noop
  }
}
