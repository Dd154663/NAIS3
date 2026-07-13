/**
 * 서버 모드 설정 (P0 전송 스위치) — 셀프호스트 서버(src/server) 접속 정보 해석.
 *
 * URL 파라미터로 켜고 끄며 localStorage에 지속된다:
 *   ?server=ws://192.168.0.10:8787&serverKey=내키   → 서버 모드 켜기(저장)
 *   ?server=off                                     → 서버 모드 끄기(로컬 모드 복귀)
 * 파라미터가 없으면 저장된 값을 쓴다. 전용 설정 UI는 P1.
 *
 * P1-②: 셀프호스트 서버가 이 페이지를 직접 서빙했으면(window.__NAIS_SERVED__) 동일 오리진으로
 * 자동 서버 모드 접속한다 — Tailscale serve(TLS 종단) 뒤에서 주소 하나만으로 되게.
 */

const KEY = 'nais3_server_url'
/** 서버가 서빙한 페이지에서 쓰는 액세스 키 지속 저장소 (?serverKey= 로 최초 주입) */
const SERVED_KEY = 'nais3_server_key'

export function resolveServerUrl(): string | null {
  const qs = new URLSearchParams(location.search)

  // 서버가 서빙한 페이지 — 프론트와 WS가 같은 오리진이므로 ?server= 파라미터가 필요 없다.
  if (window.__NAIS_SERVED__ === true) {
    // 키: ?serverKey=키 가 있으면 저장, 없으면 저장분 사용 (키 없는 서버면 빈 값)
    let accessKey = qs.get('serverKey')
    if (accessKey) {
      try {
        localStorage.setItem(SERVED_KEY, accessKey)
      } catch {
        /* 저장 불가 — 이번 세션만 적용 */
      }
    } else {
      try {
        accessKey = localStorage.getItem(SERVED_KEY)
      } catch {
        accessKey = null
      }
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const query = accessKey ? `?key=${encodeURIComponent(accessKey)}` : ''
    // nais3_server_url 저장은 하지 않는다(주소가 곧 오리진이라 지속이 불필요).
    // ?server=off도 무시한다 — 서버가 서빙한 페이지에서 로컬 모드는 비지원.
    return `${proto}://${location.host}/${query}`
  }

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

/** 재접속 중 상단 배너의 고정 id — 중복 생성 방지 + hideServerNotice()가 조회해 제거 */
const NOTICE_ID = 'nais-server-notice'

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
    // 서버가 서빙한 페이지(동일 오리진 모드)는 키 불일치면 WS가 끊긴다 → serverKey 재입력 안내를
    // 우선 노출한다. 별도 서버 주소를 쓰는 경우엔 ?server=off 로 로컬 모드 복귀를 안내한다.
    const served = window.__NAIS_SERVED__ === true
    desc.textContent = served
      ? `${message} — 키가 필요한 서버라면 주소에 ?serverKey=키 를 붙여 다시 여세요.`
      : `${message} — 서버가 켜져 있는지, 주소·키가 맞는지 확인하세요. 로컬 모드로 돌아가려면 주소에 ?server=off 를 붙여 여세요.`
    box.append(title, desc)
    document.body.appendChild(box)
    return
  }
  // 상태 전환형 배너 — 고정 id로 중복 생성을 막고 문구만 갱신한다(재접속 성공 시 hideServerNotice로 제거).
  let bar = document.getElementById(NOTICE_ID)
  if (!bar) {
    bar = document.createElement('div')
    bar.id = NOTICE_ID
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;' +
      'font-family:sans-serif;font-size:13px;padding:8px 12px;text-align:center'
    document.body.appendChild(bar)
  }
  bar.textContent = message
}

/** 재접속 성공 시 상단 배너 제거 (showServerNotice(_, false)의 짝) */
export function hideServerNotice(): void {
  document.getElementById(NOTICE_ID)?.remove()
}
