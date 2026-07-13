import type { IpcInvokeMap } from '@shared/types'
import { dispatch, emitLocal, hasHandler } from '../bus'
import { collectTransferables, type MainToWorker, type WorkerToMain } from '../rpc'

/**
 * 메인 스레드 invoke 라우터 (P5) — Electron preload의 웹 대응.
 * DOM 결합 채널(main-handlers.ts가 bus에 등록)은 로컬 디스패치, 나머지는 백엔드로 RPC.
 *
 * 백엔드는 전송(transport)만 다른 두 가지 (셀프호스트 서버 설계 — P0 전송 스위치):
 * - 로컬 모드: 브라우저 워커로 postMessage (initWorkerRpc) — 오프라인·무서버
 * - 서버 모드: 셀프호스트 서버로 msgpack over WebSocket (initServerRpc) —
 *   큐가 서버 상주라 탭을 닫아도 예약 생성이 계속 돈다
 * 프로토콜(rpc.ts의 invoke/result/event/ready)은 동일하므로 위쪽(bus·렌더러)은 모른다.
 */

export { on } from '../events'

interface Transport {
  post: (msg: MainToWorker, transfer?: ArrayBuffer[]) => void
}

let transport: Transport | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

// 워커가 만든 blob URL 미러 — 렌더러 imageUrl()의 동기 조회용 (storage.ts의 _imageUrl* 이벤트와 짝)
const imageUrlMirror = new Map<string, string>()

// 서버 모드일 때 이미지 HTTP 베이스 (서버가 nais-image 경로를 직접 서빙)
let serverImageBase: string | null = null
let serverImageKey = ''

/** 렌더러 imageUrl()이 쓰는 URL — 서버 모드는 서버 직접, 로컬은 blob 미러 ?? SW 경로 */
export function webImageUrl(filePath: string): string {
  if (serverImageBase) {
    const key = serverImageKey ? `&key=${encodeURIComponent(serverImageKey)}` : ''
    return `${serverImageBase}/nais-image/?path=${encodeURIComponent(filePath)}${key}`
  }
  return (
    imageUrlMirror.get(filePath) ??
    `${import.meta.env.BASE_URL}nais-image/?path=${encodeURIComponent(filePath)}`
  )
}

interface ReadyHandlers {
  resolveReady: (r: { dbVersion: number; channels: string[] }) => void
  rejectReady: (e: Error) => void
}

/** 백엔드 공통 수신 처리 — 전송(워커 postMessage/서버 WS)과 무관하게 동일 */
function handleBackendMessage(msg: WorkerToMain, ready: ReadyHandlers): void {
  if (msg.kind === 'result') {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.value)
    else p.reject(new Error(String(msg.value)))
  } else if (msg.kind === 'event') {
    if (msg.channel === '_imageUrlCache') {
      const { path, url } = msg.payload as { path: string; url: string }
      imageUrlMirror.set(path, url)
    } else if (msg.channel === '_imageUrlDrop') {
      imageUrlMirror.delete((msg.payload as { path: string }).path)
    } else if (msg.channel === '_bootError') {
      ready.rejectReady(new Error(String(msg.payload)))
    } else {
      emitLocal(msg.channel, msg.payload)
    }
  } else if (msg.kind === 'ready') {
    ready.resolveReady({ dbVersion: msg.dbVersion, channels: msg.channels })
  }
}

export function initWorkerRpc(w: Worker): Promise<{ dbVersion: number; channels: string[] }> {
  transport = { post: (msg, transfer) => w.postMessage(msg, transfer ?? []) }
  return new Promise((resolveReady, rejectReady) => {
    const ready = { resolveReady, rejectReady }
    w.onmessage = (event: MessageEvent<WorkerToMain>) => handleBackendMessage(event.data, ready)
    w.onerror = (e) => rejectReady(new Error(`워커 오류: ${e.message}`))
  })
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
export async function initServerRpc(
  wsUrl: string
): Promise<{ dbVersion: number; channels: string[] }> {
  const { decode, encode } = await import('@msgpack/msgpack')

  const u = new URL(wsUrl)
  serverImageKey = u.searchParams.get('key') ?? ''
  serverImageBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`

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
  let resolveReady!: (r: { dbVersion: number; channels: string[] }) => void
  let rejectReady!: (e: Error) => void
  const readyPromise = new Promise<{ dbVersion: number; channels: string[] }>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })

  // 소켓이 OPEN이면 즉시 전송, 아니면 버퍼에 쌓는다. 상한(100개/60초) 초과 시 즉시 거부해
  // 무한정 쌓이며 "조용히 사라지는" 호출을 막는다(이미 send된 뒤 끊긴 것은 pending reject 대상).
  transport = {
    post: (msg) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encode(msg))
        return
      }
      const overLimit =
        sendBuffer.length >= MAX_BUFFER ||
        (disconnectedAt !== 0 && Date.now() - disconnectedAt > MAX_DISCONNECT_MS)
      if (overLimit) {
        if (msg.kind === 'invoke') {
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            p.reject(new Error('서버 재접속 중입니다'))
          }
        }
        return
      }
      sendBuffer.push(msg)
    }
  }

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
      if (!booted) rejectReady(new Error(`서버 연결 실패: ${serverImageBase}`))
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
      const gone = new Error('서버 연결이 끊어졌습니다')
      for (const [id, p] of pending) {
        if (buffered.has(id)) continue
        pending.delete(id)
        p.reject(gone)
      }
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

/** 백엔드 RPC — 내부(`_`) 채널용. main-handlers가 데이터 위임에 쓴다 */
export function rpcInvoke<T>(channel: string, req?: unknown): Promise<T> {
  if (!transport) return Promise.reject(new Error('백엔드가 초기화되지 않았습니다'))
  const id = nextId++
  const msg: MainToWorker = { kind: 'invoke', id, channel, req }
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    transport!.post(msg, collectTransferables(req))
  })
}

export function invoke<C extends keyof IpcInvokeMap>(
  channel: C,
  req: IpcInvokeMap[C]['req']
): Promise<IpcInvokeMap[C]['res']> {
  if (hasHandler(channel)) {
    return dispatch(channel, req) as Promise<IpcInvokeMap[C]['res']>
  }
  return rpcInvoke<IpcInvokeMap[C]['res']>(channel, req)
}
