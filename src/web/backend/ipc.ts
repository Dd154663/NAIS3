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
 * 그대로 나른다. 접속이 끊기면 pending 전부 실패 처리하고 _serverDisconnected를 알린다
 * (자동 재접속은 P1 — P0은 명확한 실패가 목표).
 */
export async function initServerRpc(
  wsUrl: string
): Promise<{ dbVersion: number; channels: string[] }> {
  const { decode, encode } = await import('@msgpack/msgpack')

  const u = new URL(wsUrl)
  serverImageKey = u.searchParams.get('key') ?? ''
  serverImageBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`

  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'
  transport = { post: (msg) => ws.send(encode(msg)) }

  return new Promise((resolveReady, rejectReady) => {
    const ready = { resolveReady, rejectReady }
    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      handleBackendMessage(decode(new Uint8Array(event.data)) as WorkerToMain, ready)
    }
    ws.onerror = () => rejectReady(new Error(`서버 연결 실패: ${serverImageBase}`))
    ws.onclose = () => {
      rejectReady(new Error('서버가 연결을 종료했습니다 (키 확인)'))
      const gone = new Error('서버 연결이 끊어졌습니다')
      for (const p of pending.values()) p.reject(gone)
      pending.clear()
      emitLocal('_serverDisconnected', {})
    }
  })
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
