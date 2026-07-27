import JSZip from 'jszip'
import { GenerationQueue } from '@main/queue/generation-queue'
import { dispatch, registeredChannels, setBroadcastSink } from '../bus'
import { collectTransferables, type MainToWorker, type WorkerToMain } from '../rpc'
import { initWebDb } from '../backend/db'
import { getSetting } from '../backend/db/settings'
import { purgeStaleMemoryFiles } from '../backend/images/storage'
import { runGeneration } from '../backend/pipeline'
import { registerWorkerHandlers } from './handlers'

/**
 * 웹 워커 진입점 — Electron의 main 프로세스에 대응 (P5).
 * DB(OPFS 동기 IO)·생성 큐·NAI 호출이 전부 여기서 돌고, 메인 스레드(bootstrap)는
 * DOM IO와 RPC 중계만 한다. 부팅 완료 시 'ready'를 보내야 메인이 렌더러를 마운트한다.
 */

// jszip의 nodebuffer 지원 감지는 모듈 로드 시점 — Buffer 폴리필(index.ts)이 먼저 깔렸으므로
// 재사용하는 client.ts의 async('nodebuffer') 경로를 강제로 활성화한다.
;(JSZip as unknown as { support: { nodebuffer: boolean } }).support.nodebuffer = true

const post = (msg: WorkerToMain, transfer?: ArrayBuffer[]): void => {
  ;(globalThis as unknown as { postMessage: (m: unknown, t?: ArrayBuffer[]) => void }).postMessage(
    msg,
    transfer
  )
}

// broadcast(이벤트)를 메인으로 중계
setBroadcastSink((channel, payload) => {
  post({ kind: 'event', channel, payload })
})

async function boot(): Promise<void> {
  post({ kind: 'event', channel: '_stage', payload: 'boot-start' })
  // 지난 세션의 자동저장 OFF 원본 정리 (데스크톱의 "재시작 시 메모리 소멸"과 동일 의미)
  await purgeStaleMemoryFiles().catch(() => {})

  post({ kind: 'event', channel: '_stage', payload: 'db-init-start' })
  const { version: dbVersion } = await initWebDb()
  post({ kind: 'event', channel: '_stage', payload: 'db-init-done' })

  const queue = new GenerationQueue(runGeneration)
  const savedDelay = Number(getSetting('gen_delay_ms'))
  if (Number.isFinite(savedDelay) && savedDelay >= 0) queue.setDelayMs(savedDelay)

  registerWorkerHandlers({ dbVersion, queue })

  post({ kind: 'ready', dbVersion, channels: registeredChannels() })
}

const bootPromise = boot()

globalThis.addEventListener('message', (event: MessageEvent<MainToWorker>) => {
  const msg = event.data
  if (!msg || msg.kind !== 'invoke') return
  void bootPromise
    .then(() => dispatch(msg.channel, msg.req))
    .then((value) => {
      post({ kind: 'result', id: msg.id, ok: true, value }, collectTransferables(value))
    })
    .catch((e: unknown) => {
      post({
        kind: 'result',
        id: msg.id,
        ok: false,
        value: e instanceof Error ? e.message : String(e)
      })
    })
})

// 부팅 실패는 치명적 — 메인이 에러를 표면화할 수 있게 이벤트로 알린다
bootPromise.catch((e: unknown) => {
  post({
    kind: 'event',
    channel: '_bootError',
    payload: e instanceof Error ? (e.stack ?? e.message) : String(e)
  })
})
