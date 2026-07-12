/**
 * 채널 버스 — 메인/워커 양쪽에서 쓰는 핸들러·이벤트 레지스트리.
 * 워커는 setBroadcastSink로 broadcast를 postMessage로 흘리고,
 * 메인은 sink 없이 로컬 리스너(렌더러의 on())에 전달한다.
 *
 * 채널 이름 규약: IpcInvokeMap의 공개 채널 + `_` 접두 내부 채널
 * (메인↔워커 위임용 — 계약 밖이라 shared/types.ts를 오염시키지 않는다).
 */

type AnyHandler = (req: unknown) => unknown

const handlers = new Map<string, AnyHandler>()

export function handleRaw(channel: string, handler: AnyHandler): void {
  handlers.set(channel, handler)
}

export function hasHandler(channel: string): boolean {
  return handlers.has(channel)
}

export function dispatch(channel: string, req: unknown): Promise<unknown> {
  const h = handlers.get(channel)
  if (!h) return Promise.reject(new Error(`[web] 미구현 채널: ${channel}`))
  try {
    return Promise.resolve(h(req))
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

// ── 이벤트 ────────────────────────────────────────────────

const listeners = new Map<string, Set<(payload: unknown) => void>>()

export function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  const set = listeners.get(channel)!
  set.add(listener)
  return () => set.delete(listener)
}

/** 로컬 리스너에 비동기 전달 (ipcRenderer 이벤트처럼 호출 스택과 분리) */
export function emitLocal(channel: string, payload: unknown): void {
  queueMicrotask(() => {
    for (const fn of listeners.get(channel) ?? []) fn(payload)
  })
}

let broadcastSink: ((channel: string, payload: unknown) => void) | null = null

/** 워커에서 호출 — broadcast를 메인으로 흘려보내는 통로 설치 */
export function setBroadcastSink(sink: (channel: string, payload: unknown) => void): void {
  broadcastSink = sink
}

export function broadcastRaw(channel: string, payload: unknown): void {
  if (broadcastSink) broadcastSink(channel, payload)
  else emitLocal(channel, payload)
}
