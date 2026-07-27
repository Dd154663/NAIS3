import type { IpcEventMap } from '@shared/types'
import { broadcastRaw, subscribe } from './bus'

/**
 * IpcEventMap 계약으로 좁힌 이벤트 파사드 — 메인/워커 공용.
 * 워커에서 broadcast하면 bus의 sink(postMessage)를 타고 메인 리스너에 도달한다.
 */

export function broadcast<C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void {
  broadcastRaw(channel, payload)
}

export function on<C extends keyof IpcEventMap>(
  channel: C,
  listener: (payload: IpcEventMap[C]) => void
): () => void {
  return subscribe(channel, listener as (payload: unknown) => void)
}
