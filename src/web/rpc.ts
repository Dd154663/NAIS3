/**
 * 메인 ↔ 워커 RPC 메시지 타입.
 * - invoke/result: 채널 호출 왕복 (Uint8Array 페이로드는 transferable로 이동)
 * - event: 워커 broadcast → 메인 리스너 브릿지
 * - ready: 워커 부팅 완료 핸드셰이크 (DB 초기화·마이그레이션 이후)
 */

export interface RpcInvoke {
  kind: 'invoke'
  id: number
  channel: string
  req: unknown
}

export interface RpcResult {
  kind: 'result'
  id: number
  ok: boolean
  /** ok=true면 응답, false면 에러 메시지 */
  value: unknown
}

export interface RpcEvent {
  kind: 'event'
  channel: string
  payload: unknown
}

export interface RpcReady {
  kind: 'ready'
  dbVersion: number
  /** 워커에 등록된 채널 목록 — 채널 커버리지 대조용 (channel-coverage.ts, DEV) */
  channels: string[]
}

export type WorkerToMain = RpcResult | RpcEvent | RpcReady
export type MainToWorker = RpcInvoke

/** 메시지 안의 Uint8Array/ArrayBuffer들을 transferable 목록으로 수집 (얕은 재귀) */
export function collectTransferables(value: unknown, out: ArrayBuffer[] = []): ArrayBuffer[] {
  if (value instanceof Uint8Array) {
    // SharedArrayBuffer가 아닌 경우만 transfer 가능
    if (value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer)
  } else if (Array.isArray(value)) {
    for (const v of value) collectTransferables(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectTransferables(v, out)
  }
  return out
}
