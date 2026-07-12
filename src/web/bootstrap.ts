import JSZip from 'jszip'
import { GenerationQueue } from '@main/queue/generation-queue'
import type { NaisApi } from '../preload/index'
import { initWebDb } from './backend/db'
import { getSetting, setSetting } from './backend/db/settings'
import { broadcast, invoke, on, registerWebHandlers } from './backend/ipc'
import { runGeneration } from './backend/pipeline'
import { purgeStaleMemoryFiles, webImageUrl } from './backend/images/storage'

/**
 * 웹 부트스트랩 — Electron의 main/preload 역할을 브라우저 안에서 수행한 뒤
 * 기존 렌더러를 "무수정"으로 마운트한다.
 * 순서가 중요하다: DB → 큐/핸들러 → window.nais → 서비스워커 → 렌더러.
 */
export async function start(): Promise<void> {
  // jszip의 nodebuffer 지원 감지는 모듈 로드 시점 — Buffer 폴리필(main.ts)이 먼저 깔렸으므로
  // 재사용하는 client.ts의 async('nodebuffer') 경로를 강제로 활성화한다.
  ;(JSZip as unknown as { support: { nodebuffer: boolean } }).support.nodebuffer = true

  // 지난 세션의 자동저장 OFF 원본 정리 (데스크톱의 "재시작 시 메모리 소멸"과 동일 의미)
  await purgeStaleMemoryFiles().catch(() => {})

  const { version: dbVersion } = await initWebDb()

  const queue = new GenerationQueue(runGeneration)
  const savedDelay = Number(getSetting('gen_delay_ms'))
  if (Number.isFinite(savedDelay) && savedDelay >= 0) queue.setDelayMs(savedDelay)

  registerWebHandlers({ dbVersion, queue })

  // 웹검색 모드는 Electron <webview> 전용이라 웹에선 동작하지 않는다 —
  // "표시할 탭" 설정이 미설정일 때만 기본 숨김 (사용자가 설정에서 다시 켤 수 있음)
  if (getSetting('ui_hidden_pages') === null) {
    setSetting('ui_hidden_pages', JSON.stringify(['websearch']))
  }

  // 브라우저의 저장소 자동 회수(특히 iOS 미사용 시 삭제) 방지 요청 — 거부돼도 무해
  if (navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {})
  }

  const api: NaisApi = { invoke, on, imageUrl: webImageUrl }
  ;(window as unknown as { nais: NaisApi }).nais = api

  // 이미지 서빙 + 앱 셸 캐시 서비스워커. 실패해도 치명적이진 않다 —
  // 최근 생성분은 오브젝트 URL 캐시로 표시되고, 히스토리 카드는 DB 썸네일을 쓴다.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      // 새 배포 감지 → 데스크톱 자동 업데이트 UI 재활용 ("재시작" = 웹에선 reload)
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            broadcast('update:status', { state: 'downloaded' })
          }
        })
      })
    } catch (e) {
      console.warn('[web] 서비스워커 등록 실패 — 저장 이미지 풀해상도 표시가 제한됩니다', e)
    }
  }

  // dev 전용 디버그 표면 — 채널 검증 시 테스트 데이터 주입용 (프로덕션 번들에선 제거됨)
  if (import.meta.env.DEV) {
    const { getDb } = await import('./backend/db')
    const { idbGet, idbPut, idbKeys } = await import('./backend/idb')
    const { exportAllWeb, importAllWeb } = await import('./backend/backup')
    ;(window as unknown as Record<string, unknown>).__naisDev = {
      getDb,
      idbGet,
      idbPut,
      idbKeys,
      exportAllWeb,
      importAllWeb
    }
  }

  await import('@renderer/main')
}
