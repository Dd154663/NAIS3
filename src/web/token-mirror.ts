/**
 * NAI 토큰 내구성 미러 (연동 편의성) — 메인 스레드 전용.
 *
 * 토큰의 원본 저장소는 워커 DB(settings 테이블)지만, OPFS가 세션 간 축출되는 환경
 * (특히 iOS Safari, 일부 localhost 구성)에서는 DB째 초기화돼 매 세션 토큰 재입력이
 * 필요했다. localStorage는 워커에서 접근 불가하므로 메인 스레드가 미러를 유지하고,
 * 부팅 시 DB에 토큰이 없으면(_token:restore) 미러에서 되살린다.
 *
 * 보안 수준은 기존 DB 저장(base64, OS 키체인 없음)과 동일하다 — localStorage도
 * 사이트 데이터 삭제 시 함께 지워진다. base64는 devtools에서 토큰이 평문으로
 * 노출되지 않게 하는 최소한의 난독화일 뿐 암호화가 아니다.
 */
const KEY = 'nais3_web_token'

/** 토큰 저장(연결) 성공 시 미러에 반영 */
export function mirrorToken(token: string): void {
  try {
    localStorage.setItem(KEY, btoa(token))
  } catch {
    // localStorage 불가(프라이빗 모드/용량 초과 등) — 미러 없이도 DB 저장은 동작한다
  }
}

/** 부팅 복원용 — 미러에 저장된 토큰(없으면 null) */
export function readMirroredToken(): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return v ? atob(v) : null
  } catch {
    return null
  }
}

/** 토큰 삭제 시 미러도 제거 */
export function clearMirroredToken(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // noop
  }
}
