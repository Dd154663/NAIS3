/**
 * 웹 진입점. Buffer 폴리필을 "가장 먼저" 설치한 뒤 나머지를 동적 import한다
 * — 재사용하는 src/main 모듈들(client/stream/storage)과 jszip이 전역 Buffer를 전제하기 때문.
 */
import { Buffer } from 'buffer'

;(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer

void import('./bootstrap')
  .then((m) => m.start())
  .catch((e: unknown) => {
    document.getElementById('root')!.innerHTML =
      `<div style="padding:2rem;font-family:sans-serif;color:#c66">` +
      `<h2>NAIS3 웹을 시작하지 못했습니다</h2><pre>${e instanceof Error ? e.stack : String(e)}</pre></div>`
  })
