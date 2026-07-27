import { handleBackendMessage, setTransport, type BackendReady } from '../backend/ipc'
import type { WorkerToMain } from '../rpc'

/**
 * 전송 계층 — 로컬 모드 (브라우저 워커가 백엔드).
 *
 * 서버 없이 도는 기본 전송. 워커(src/web/worker)를 Electron main 프로세스처럼 띄우고
 * postMessage로 RPC를 나른다. 전송 계층의 짝은 transport/server.ts이며,
 * 공통 라우터(backend/ipc.ts)는 어느 쪽이 붙었는지 모른다 — transport/* → backend/ipc.ts 단방향.
 */

/** 워커 전송 부착 + ready 핸드셰이크 대기 (DB 초기화·마이그레이션 완료 보장) */
function initWorkerRpc(w: Worker): Promise<BackendReady> {
  setTransport({ post: (msg, transfer) => w.postMessage(msg, transfer ?? []) })
  return new Promise((resolveReady, rejectReady) => {
    const ready = { resolveReady, rejectReady }
    w.onmessage = (event: MessageEvent<WorkerToMain>) => handleBackendMessage(event.data, ready)
    w.onerror = (e) => rejectReady(new Error(`워커 오류: ${e.message}`))
  })
}

/** 워커 생성 + 부팅 — ready(DB 버전·등록 채널)를 돌려준다 */
export function startWorkerTransport(): Promise<BackendReady> {
  const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' })
  return initWorkerRpc(worker)
}
