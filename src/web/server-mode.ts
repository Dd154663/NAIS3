/**
 * 서버 모드 설정 (P0 전송 스위치) — 셀프호스트 서버(src/server) 접속 정보 해석.
 *
 * URL 파라미터로 켜고 끄며 localStorage에 지속된다:
 *   ?server=ws://192.168.0.10:8787&serverKey=내키   → 서버 모드 켜기(저장)
 *   ?server=off                                     → 서버 모드 끄기(로컬 모드 복귀)
 * 파라미터가 없으면 저장된 값을 쓴다. 전용 설정 UI는 P1.
 */

const KEY = 'nais3_server_url'

export function resolveServerUrl(): string | null {
  const qs = new URLSearchParams(location.search)
  const param = qs.get('server')
  if (param === 'off') {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* noop */
    }
    return null
  }
  if (param) {
    try {
      const url = new URL(param.includes('://') ? param : `ws://${param}`)
      const accessKey = qs.get('serverKey')
      if (accessKey) url.searchParams.set('key', accessKey)
      const s = url.toString()
      try {
        localStorage.setItem(KEY, s)
      } catch {
        /* 저장 불가 — 이번 세션만 적용 */
      }
      return s
    } catch {
      console.error('[web] server 파라미터가 올바른 주소가 아닙니다:', param)
      return null
    }
  }
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** 접속 실패/끊김 안내 — 부팅 전 실패는 전체 화면, 이후 끊김은 상단 배너 */
export function showServerNotice(message: string, fatal: boolean): void {
  if (fatal) {
    document.body.innerHTML = ''
    const box = document.createElement('div')
    box.style.cssText =
      'display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;' +
      'height:100vh;background:#0f0f10;color:#e5e5e5;font-family:sans-serif;padding:24px;text-align:center'
    const title = document.createElement('div')
    title.style.cssText = 'font-size:18px;font-weight:600'
    title.textContent = '서버에 연결할 수 없습니다'
    const desc = document.createElement('div')
    desc.style.cssText = 'font-size:13px;color:#a3a3a3;max-width:480px;line-height:1.6'
    desc.textContent = `${message} — 서버가 켜져 있는지, 주소·키가 맞는지 확인하세요. 로컬 모드로 돌아가려면 주소에 ?server=off 를 붙여 여세요.`
    box.append(title, desc)
    document.body.appendChild(box)
    return
  }
  const bar = document.createElement('div')
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;' +
    'font-family:sans-serif;font-size:13px;padding:8px 12px;text-align:center'
  bar.textContent = `${message} — 새로고침으로 재접속하세요.`
  document.body.appendChild(bar)
}
