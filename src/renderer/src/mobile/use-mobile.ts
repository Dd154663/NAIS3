import { useEffect, useState } from 'react'

/** 모바일 셸 진입 기준 폭 — 태블릿 세로(820px)보다 좁으면 모바일 레이아웃 */
export const MOBILE_MAX_WIDTH = 819

const QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`

/**
 * 화면 폭 기준 모바일 판정 (matchMedia + change 리스너).
 *
 * 설정 `ui_mobile`('auto'|'on'|'off') 오버라이드는 다음 차수 — 기존 `settings:get/set`
 * 임의 키를 재사용할 예정이라 새 IPC 채널은 여전히 0개다.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches
  )

  useEffect(() => {
    const mq = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent): void => setMobile(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return mobile
}
