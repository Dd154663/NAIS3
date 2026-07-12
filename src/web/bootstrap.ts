import type { NaisApi } from '../preload/index'
import { broadcast } from './events'
import { initWorkerRpc, invoke, on, rpcInvoke, webImageUrl } from './backend/ipc'
import { registerMainHandlers } from './main-handlers'
import {
  connectDrive,
  disconnectDrive,
  gdriveStatus,
  isDriveConfigured
} from './gdrive-controller'

/**
 * 웹 부트스트랩 (P5) — Electron의 preload 역할.
 * 백엔드(DB·큐·NAI)는 워커(src/web/worker)가 Electron main 프로세스처럼 담당하고,
 * 메인 스레드는 DOM IO 핸들러와 RPC 중계, window.nais 주입만 한다.
 * 순서: 워커 부팅(ready 대기) → 메인 핸들러 → window.nais → SW → 렌더러.
 */
export async function start(): Promise<void> {
  const worker = new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module' })
  // ready 핸드셰이크 (DB 초기화·마이그레이션 완료 보장)
  const ready = await initWorkerRpc(worker)

  registerMainHandlers()

  // Drive 토큰 발급은 사용자 제스처(패널 연결/재연결 버튼)로만 — GIS 팝업은 제스처 없이 차단되므로
  // 부팅 자동 재연결은 하지 않는다. 워커가 이전 세션 설정으로 프로바이더를 선활성해 큐를 유지하고,
  // 패널(P6-5)이 "재연결 필요"를 표시한다.

  // 채널 선언표 ↔ 실제 등록 대조 (가드레일 G1 — DEV 전용, 프로덕션 번들에선 제거)
  if (import.meta.env.DEV) {
    const { verifyChannelCoverage } = await import('./channel-coverage')
    const { hasHandler } = await import('./bus')
    verifyChannelCoverage(ready.channels, hasHandler)
  }

  // 웹검색 모드는 Electron <webview> 전용이라 웹에선 동작하지 않는다 —
  // "표시할 탭" 설정이 미설정일 때만 기본 숨김 (사용자가 설정에서 다시 켤 수 있음)
  const hidden = await invoke('settings:get', { key: 'ui_hidden_pages' })
  if (hidden.value === null) {
    await invoke('settings:set', { key: 'ui_hidden_pages', value: JSON.stringify(['websearch']) })
  }

  // 브라우저의 저장소 자동 회수(특히 iOS 미사용 시 삭제) 방지 요청 — 거부돼도 무해
  if (navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {})
  }

  const api: NaisApi = { invoke, on, imageUrl: webImageUrl }
  ;(window as unknown as { nais: NaisApi }).nais = api

  // 이미지 서빙 + 앱 셸 캐시 서비스워커. 실패해도 치명적이진 않다 —
  // 최근 생성분은 blob URL 미러로 표시되고, 히스토리 카드는 DB 썸네일을 쓴다.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      // 새 배포 감지 → 데스크톱 자동 업데이트 UI 재활용 ("재시작" = 웹에선 reload)
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            broadcast('update:status', { state: 'downloaded' })
          }
        })
      })
    } catch (e) {
      console.warn('[web] 서비스워커 등록 실패 — 저장 이미지 풀해상도 표시가 제한됩니다', e)
    }
  }

  // dev 전용 디버그 표면 — 검증 프로브의 테스트 데이터 주입용 (프로덕션 번들에선 제거됨).
  // DB는 워커에 있으므로 SQL은 RPC(_dev:sql), IndexedDB는 같은 오리진이라 메인에서 직접.
  if (import.meta.env.DEV) {
    const { idbGet, idbPut, idbKeys } = await import('./backend/idb')
    ;(window as unknown as Record<string, unknown>).__naisDev = {
      rpc: (channel: string, req?: unknown) => rpcInvoke(channel, req),
      sql: (sql: string, params?: unknown[], mode?: 'all' | 'run') =>
        rpcInvoke('_dev:sql', { sql, params, mode }),
      idbGet,
      idbPut,
      idbKeys,
      exportAll: async () => JSON.parse(await rpcInvoke<string>('_backup:exportJson')),
      importAll: (data: unknown) =>
        rpcInvoke('_backup:importJson', { text: JSON.stringify(data) }),
      gdrive: {
        configured: isDriveConfigured(),
        connect: () => connectDrive(),
        disconnect: () => disconnectDrive(),
        status: () => gdriveStatus(),
        selftest: () => rpcInvoke('_dev:gdriveSelftest'),
        providerTest: () => rpcInvoke('_dev:driveProviderTest')
      }
    }
  }

  await import('@renderer/main')
}
