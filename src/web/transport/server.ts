import type { NaisApi } from '../../preload/index'
import {
  handleBackendMessage,
  invoke,
  on,
  rejectAllPending,
  rejectPending,
  rpcInvoke,
  setServerImageBase,
  setTransport,
  webImageUrl,
  type BackendReady,
  type ReadyHandlers
} from '../backend/ipc'
import { emitLocal } from '../bus'
import { registerMainHandlers } from '../main-handlers'
import type { MainToWorker, WorkerToMain } from '../rpc'

/**
 * 전송 계층 — 서버 모드 (셀프호스트 서버가 백엔드).
 *
 * **이 파일은 웹 포트와 셀프호스트 서버의 경계다.** 웹(src/web)에서 서버(src/server)에
 * 의존하는 코드는 전부 여기에 모아 두어, 서버 기능을 빼도 로컬 모드가 그대로 서게 한다.
 * (backend/ipc.ts는 전송에 무관한 공통 라우터만 유지 — transport/* → backend/ipc.ts 단방향.)
 *
 * 담는 것: 접속 정보 해석(?server= 쿼리·localStorage·동일 오리진), WS+msgpack 전송과
 * 자동 재접속, 접속 실패/끊김 배너 UI, 서버 모드 부팅 절차.
 */

/**
 * 서버가 서빙한 페이지 표식 — src/server/static-web.ts가 index.html의 `</head>` 앞에 주입한다.
 * true면 동일 오리진 자동 서버 모드로 부팅한다 (resolveServerUrl).
 */
declare global {
  interface Window {
    __NAIS_SERVED__?: boolean
  }
}

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
    // 셀프호스트 가이드 링크 — 서버 세팅을 처음 하는 사용자의 탈출로. 새 탭으로 연다.
    const guide = document.createElement('a')
    guide.href = `${import.meta.env.BASE_URL}self-host.html`
    guide.target = '_blank'
    guide.rel = 'noopener'
    guide.textContent = '셀프호스트 가이드 열기'
    guide.style.cssText = 'font-size:13px;color:#eb9550;text-decoration:none'
    box.append(title, desc, guide)
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

/**
 * 서버 모드 전송 — 셀프호스트 서버(src/server)에 WebSocket으로 접속한다.
 * ready까지 포함해 프로토콜이 워커와 동일. msgpack은 Uint8Array 페이로드(썸네일 등)를
 * 그대로 나른다.
 *
 * 자동 재접속(P1-③): 최초 접속은 재시도하지 않는다(주소·키가 틀리면 명확히 실패해야 하므로
 * ready Promise를 reject). 부팅 성공 이후 끊기면 지수 백오프(1→2→4→8→상한 15s)로 무한
 * 재시도하고, 화면이 다시 보이면(visibilitychange) 대기 타이머를 앞당겨 즉시 시도한다.
 * 끊기면 진행 중(pending) 호출은 전부 reject(실행 여부를 알 수 없어 자동 재시도는 위험),
 * 재접속에 성공하면 놓친 큐 이벤트를 queue:status 재주입으로 따라잡는다.
 */
export async function initServerRpc(wsUrl: string): Promise<BackendReady> {
  const { decode, encode } = await import('@msgpack/msgpack')

  const u = new URL(wsUrl)
  const imageKey = u.searchParams.get('key') ?? ''
  const imageBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`
  // 렌더러 imageUrl()이 서버 직접 서빙 URL을 쓰도록 공통 라우터에 주입 (webImageUrl의 서버 분기)
  setServerImageBase(imageBase, imageKey)

  const MAX_BACKOFF_MS = 15000
  const MAX_BUFFER = 100 // 미전송 버퍼 상한(개수)
  const MAX_DISCONNECT_MS = 60000 // 끊긴 지 이 시간 초과면 이후 invoke 즉시 거부

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 1000
  let disconnectedAt = 0 // 끊긴 시각(0=연결됨)
  let booted = false // 최초 ready 수신 여부
  const sendBuffer: MainToWorker[] = [] // 소켓이 OPEN이 아닐 때 쌓이는 미전송분

  // 최초 접속 Promise — 부팅 성공/실패 1회만 해석한다(재접속은 이 Promise를 건드리지 않는다).
  let resolveReady!: (r: BackendReady) => void
  let rejectReady!: (e: Error) => void
  const readyPromise = new Promise<BackendReady>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  // 소켓이 OPEN이면 즉시 전송, 아니면 버퍼에 쌓는다. 상한(100개/60초) 초과 시 즉시 거부해
  // 무한정 쌓이며 "조용히 사라지는" 호출을 막는다(이미 send된 뒤 끊긴 것은 pending reject 대상).
  setTransport({
    post: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encode(msg))
        return
      }
      const overLimit =
        sendBuffer.length >= MAX_BUFFER ||
        (disconnectedAt !== 0 && Date.now() - disconnectedAt > MAX_DISCONNECT_MS)
      if (overLimit) {
        if (msg.kind === 'invoke') rejectPending(msg.id, new Error('서버 재접속 중입니다'))
        return
      }
      sendBuffer.push(msg)
    }
  })

  const flushBuffer = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    while (sendBuffer.length) ws.send(encode(sendBuffer.shift()!))
  }

  const scheduleReconnect = (): void => {
    if (reconnectTimer !== null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  // 재접속 성공 후 재동기화 — 끊긴 동안 놓친 queue:changed를 현재 상태로 따라잡는다.
  const resyncQueue = async (): Promise<void> => {
    try {
      const status = await rpcInvoke('queue:status', undefined)
      emitLocal('queue:changed', status)
    } catch {
      /* 재동기화 실패는 이후 실이벤트로 자연 복구되므로 무시 */
    }
  }

  function connect(): void {
    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    ws = socket
    const ready: ReadyHandlers = {
      resolveReady: (r) => {
        if (!booted) {
          booted = true
          resolveReady(r)
          flushBuffer()
          return
        }
        // 재접속 성공 — 백오프 리셋 + 알림 + 미전송분 flush + 큐 재동기화(ready 내용은 무시)
        backoff = 1000
        disconnectedAt = 0
        emitLocal('_serverReconnected', {})
        flushBuffer()
        void resyncQueue()
      },
      rejectReady: (e) => {
        if (!booted) rejectReady(e)
        // 부팅 이후엔 무시 — onclose가 재접속을 담당
      }
    }
    socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      handleBackendMessage(decode(new Uint8Array(event.data)) as WorkerToMain, ready)
    }
    socket.onerror = () => {
      if (!booted) rejectReady(new Error(`서버 연결 실패: ${imageBase}`))
    }
    socket.onclose = () => {
      if (ws !== socket) return // 이미 교체된 낡은 소켓의 close는 무시
      if (!booted) {
        // 최초 접속 실패 — 재시도하지 않고 명확히 실패시킨다(키·주소 오류를 드러내려고)
        rejectReady(new Error('서버가 연결을 종료했습니다 (키 확인)'))
        return
      }
      const firstDrop = disconnectedAt === 0
      if (firstDrop) disconnectedAt = Date.now()
      // 이미 send된 뒤 답을 못 받은 pending만 reject한다(실행 여부를 알 수 없어 자동 재시도는
      // 위험). 아직 미전송(버퍼)인 호출은 재접속 flush로 살려야 하므로 건드리지 않는다 —
      // 재접속 시도가 여러 번 실패하는 동안 버퍼분의 pending이 쓸려나가지 않게 한다.
      const buffered = new Set(sendBuffer.map((m) => m.id))
      rejectAllPending(new Error('서버 연결이 끊어졌습니다'), (id) => buffered.has(id))
      if (firstDrop) emitLocal('_serverDisconnected', {})
      scheduleReconnect()
    }
  }

  // 화면이 다시 보이면 대기 중이던 재접속 타이머를 앞당겨 즉시 시도(백오프 리셋).
  // 모바일에서 화면을 껐다 켤 때 백오프 상한(15s)만큼 기다리지 않게 하는 것이 목적이다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (reconnectTimer === null) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    backoff = 1000
    connect()
  })

  connect()
  return readyPromise
}

/**
 * 서버 모드 부팅 — 백엔드가 셀프호스트 서버라 로컬 전용 장치가 전부 불필요/무의미하다:
 * 단일 탭 가드(OPFS 없음 — 다중 탭 허용), 토큰 미러(토큰은 서버 DB 상주), storage.persist,
 * Drive 패널(서버 저장이 곧 클라우드 저장), 서비스워커(이미지는 서버가 직접 서빙).
 * P0 공백(서버 미구현 웹 내부 채널): _backup/_refs/_frags/_scenes/_library/_images:readBytes —
 * 해당 가져오기/내보내기 흐름은 호출 시 명확한 에러로 드러난다. P1에서 서버에 이식.
 */
export async function startServerMode(serverUrl: string): Promise<void> {
  let ready: BackendReady
  try {
    ready = await initServerRpc(serverUrl)
  } catch (e) {
    showServerNotice(e instanceof Error ? e.message : String(e), true)
    return
  }

  registerMainHandlers()

  // 채널 선언표 ↔ 서버 등록 대조 (가드레일 G1) — 서버는 데스크톱 등록표 전체를 재사용하므로
  // 전량 커버가 기대값이다
  if (import.meta.env.DEV) {
    const { verifyChannelCoverage } = await import('../channel-coverage')
    const { hasHandler } = await import('../bus')
    verifyChannelCoverage(ready.channels, hasHandler)
  }

  // 웹검색 모드 기본 숨김 — 로컬 모드와 동일 (Electron <webview> 전용 기능)
  const hidden = await invoke('settings:get', { key: 'ui_hidden_pages' })
  if (hidden.value === null) {
    await invoke('settings:set', { key: 'ui_hidden_pages', value: JSON.stringify(['websearch']) })
  }

  const api: NaisApi = { invoke, on, imageUrl: webImageUrl }
  ;(window as unknown as { nais: NaisApi }).nais = api

  // 끊김/재접속 상태를 상단 배너로 반영 — 이 파일의 initServerRpc가 자동 재접속(지수 백오프)을
  // 담당하므로 여기서는 안내만 전환한다. 끊기면 "재접속 중" 배너, 재접속 성공 시 배너 제거.
  const { subscribe } = await import('../bus')
  subscribe('_serverDisconnected', () => {
    showServerNotice('서버 연결이 끊어졌습니다 — 자동 재접속 중…', false)
  })
  subscribe('_serverReconnected', () => {
    hideServerNotice()
  })

  await import('@renderer/main')
  console.log(
    `[web] 서버 모드 — ${serverUrl.replace(/key=[^&]*/, 'key=***')} (채널 ${ready.channels.length}개, DB v${ready.dbVersion})`
  )
}
