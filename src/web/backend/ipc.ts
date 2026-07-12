import type { IpcInvokeMap } from '@shared/types'
import { dispatch, emitLocal, hasHandler } from '../bus'
import { collectTransferables, type MainToWorker, type WorkerToMain } from '../rpc'

/**
 * 메인 스레드 invoke 라우터 (P5) — Electron preload의 웹 대응.
 * DOM 결합 채널(main-handlers.ts가 bus에 등록)은 로컬 디스패치,
 * 나머지는 워커(Electron main 프로세스 대응)로 postMessage RPC.
 * 워커의 broadcast 이벤트는 emitLocal로 렌더러 리스너(on)에 전달된다.
 */

export { on } from '../events'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

// 워커가 만든 blob URL 미러 — 렌더러 imageUrl()의 동기 조회용 (storage.ts의 _imageUrl* 이벤트와 짝)
const imageUrlMirror = new Map<string, string>()

/** 렌더러 imageUrl()이 쓰는 URL — 캐시 히트 시 blob URL, 아니면 SW 경로 (base 하위 배포 대응) */
export function webImageUrl(filePath: string): string {
  return (
    imageUrlMirror.get(filePath) ??
    `${import.meta.env.BASE_URL}nais-image/?path=${encodeURIComponent(filePath)}`
  )
}

export function initWorkerRpc(w: Worker): Promise<{ dbVersion: number; channels: string[] }> {
  worker = w
  return new Promise((resolveReady, rejectReady) => {
    w.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const msg = event.data
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
          rejectReady(new Error(String(msg.payload)))
        } else {
          emitLocal(msg.channel, msg.payload)
        }
      } else if (msg.kind === 'ready') {
        resolveReady({ dbVersion: msg.dbVersion, channels: msg.channels })
      }
    }
    w.onerror = (e) => rejectReady(new Error(`워커 오류: ${e.message}`))
  })
}

/** 워커 RPC — 내부(`_`) 채널용. main-handlers가 데이터 위임에 쓴다 */
export function rpcInvoke<T>(channel: string, req?: unknown): Promise<T> {
  if (!worker) return Promise.reject(new Error('워커가 초기화되지 않았습니다'))
  const id = nextId++
  const msg: MainToWorker = { kind: 'invoke', id, channel, req }
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage(msg, collectTransferables(req))
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
