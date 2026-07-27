/**
 * 워커 진입점. main.ts와 같은 이유로 Buffer 폴리필을 "가장 먼저" 설치한 뒤
 * 본체(boot.ts)를 동적 import한다 — 재사용하는 src/main 모듈들이 전역 Buffer를 전제.
 */
import { Buffer } from 'buffer'

;(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer

// 부팅 단계 계측 — 어느 단계에서 멈췄는지 메인에서 관찰 가능 (알 수 없는 kind는 무시됨)
const stage = (v: string): void =>
  (globalThis as unknown as { postMessage: (m: unknown) => void }).postMessage({
    kind: 'stage',
    v
  })
stage('entry')

import('./boot').then(
  () => stage('boot-module-loaded'),
  (e: unknown) => stage(`boot-import-failed: ${e instanceof Error ? e.message : String(e)}`)
)
