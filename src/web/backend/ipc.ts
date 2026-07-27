import type { IpcInvokeMap } from '@shared/types'
import { dispatch, emitLocal, hasHandler } from '../bus'
import { collectTransferables, type MainToWorker, type WorkerToMain } from '../rpc'

/**
 * 메인 스레드 invoke 라우터 (P5) — Electron preload의 웹 대응.
 * DOM 결합 채널(main-handlers.ts가 bus에 등록)은 로컬 디스패치, 나머지는 백엔드로 RPC.
 *
 * 백엔드에 닿는 경로는 전송(transport)으로 갈라진다 — 현재는 브라우저 워커로 postMessage
 * (transport/worker.ts, 오프라인·무서버) 하나뿐이고, 원격 전송(예: WebSocket 백엔드)은
 * 같은 계약으로 나중에 꽂히는 확장 지점이다.
 * 프로토콜(rpc.ts의 invoke/result/event/ready)은 전송과 무관하므로 위쪽(bus·렌더러)은 모른다.
 *
 * 이 파일에는 전송에 무관한 공통부만 둔다 — 실제 전송 구현은 src/web/transport/* 이고,
 * 그쪽이 setTransport()로 자신을 꽂는다 (transport/* → 이 파일 단방향, 역참조 금지).
 */

export { on } from '../events'

/** 전송 구현이 만족해야 하는 계약 (워커 postMessage, 혹은 원격 전송의 send) */
export interface Transport {
  post: (msg: MainToWorker, transfer?: ArrayBuffer[]) => void
}

/** 백엔드 ready 핸드셰이크 결과 — DB 버전 + 등록된 채널 목록 */
export interface BackendReady {
  dbVersion: number
  channels: string[]
}

let transport: Transport | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** 전송 부착 — transport/* 구현이 부팅 시 1회 호출한다 */
export function setTransport(t: Transport): void {
  transport = t
}

/** 진행 중 호출 1건 거부 — 전송이 미전송 상한을 넘겨 호출을 버릴 때 (원격 전송 확장용) */
export function rejectPending(id: number, error: Error): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  p.reject(error)
}

/** 진행 중 호출 일괄 거부 — keep(id)가 true면 남긴다(재전송으로 살릴 미전송분) */
export function rejectAllPending(error: Error, keep?: (id: number) => boolean): void {
  for (const [id, p] of pending) {
    if (keep?.(id)) continue
    pending.delete(id)
    p.reject(error)
  }
}

// 워커가 만든 blob URL 미러 — 렌더러 imageUrl()의 동기 조회용 (storage.ts의 _imageUrl* 이벤트와 짝)
const imageUrlMirror = new Map<string, string>()

// 원격 전송이 붙었을 때의 이미지 HTTP 베이스 (원격이 nais-image 경로를 직접 서빙하는 경우).
// 워커 전송에서는 주입되지 않아 아래 분기가 불활성이다 — 원격 전송 확장용 이음매.
let serverImageBase: string | null = null
let serverImageKey = ''

/** 원격 전송이 붙을 때 이미지 서빙 오리진·키 주입 (webImageUrl의 원격 분기 스위치) */
export function setServerImageBase(base: string, key: string): void {
  serverImageBase = base
  serverImageKey = key
}

/** 렌더러 imageUrl()이 쓰는 URL — 원격 베이스가 주입됐으면 그쪽, 아니면 blob 미러 ?? SW 경로 */
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

/** 최초 ready 대기 Promise의 해석 함수 쌍 — 전송이 만들어 handleBackendMessage에 넘긴다 */
export interface ReadyHandlers {
  resolveReady: (r: BackendReady) => void
  rejectReady: (e: Error) => void
}

/** 백엔드 공통 수신 처리 — 어느 전송이 붙었든 동일 */
export function handleBackendMessage(msg: WorkerToMain, ready: ReadyHandlers): void {
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
