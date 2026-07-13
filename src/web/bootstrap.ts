import type { IpcInvokeMap } from '@shared/types'
import type { NaisApi } from '../preload/index'
import { broadcast } from './events'
import { broadcastRaw } from './bus'
import { initServerRpc, initWorkerRpc, invoke, on, rpcInvoke, webImageUrl } from './backend/ipc'
import { registerMainHandlers } from './main-handlers'
import {
  connectDrive,
  disconnectDrive,
  gdriveStatus,
  isDriveConfigured,
  restoreDriveSession
} from './gdrive-controller'
import { mountGdrivePanel } from './gdrive-panel'
import { clearMirroredToken, mirrorToken, readMirroredToken } from './token-mirror'
import { acquireSingleTabLock, showMultiTabNotice } from './single-tab-guard'
import { hideServerNotice, resolveServerUrl, showServerNotice } from './server-mode'

/**
 * 웹 부트스트랩 (P5) — Electron의 preload 역할.
 * 백엔드(DB·큐·NAI)는 워커(src/web/worker)가 Electron main 프로세스처럼 담당하고,
 * 메인 스레드는 DOM IO 핸들러와 RPC 중계, window.nais 주입만 한다.
 * 순서: 워커 부팅(ready 대기) → 메인 핸들러 → window.nais → SW → 렌더러.
 */
export async function start(): Promise<void> {
  // 서버 모드 (P0 전송 스위치) — 셀프호스트 서버가 백엔드면 워커·OPFS를 아예 만들지 않는다.
  // 큐·DB·이미지가 서버 상주라 탭을 닫아도 예약 생성이 계속 도는 것이 서버 모드의 존재 이유.
  const serverUrl = resolveServerUrl()
  if (serverUrl) return startServerMode(serverUrl)

  // 단일 탭 가드 (잠정) — opfs-sahpool은 단일 연결만 허용. 2번째 탭은 워커를 만들지 않고 안내만
  // (그대로 두면 워커가 OPFS 충돌로 조용히 죽어 원인 불명의 에러가 된다).
  if (!(await acquireSingleTabLock())) {
    showMultiTabNotice()
    return
  }

  const worker = new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module' })
  // ready 핸드셰이크 (DB 초기화·마이그레이션 완료 보장)
  const ready = await initWorkerRpc(worker)

  registerMainHandlers()

  // Drive: 저장된 액세스 토큰이 만료 전이면 부팅 시 GIS 재호출·팝업 없이 재사용해 재연결한다
  // (restoreDriveSession, 렌더러 마운트 뒤). 토큰 만료(~1h 경과) 후엔 워커가 프로바이더를 선활성해
  // 큐를 유지하고 패널(P6-5)이 "재연결 필요"를 표시하며, 동의 팝업(connectDrive)은 제스처가 필요해
  // 패널 버튼에서만 뜬다 — GIS는 리프레시 토큰이 없어 무팝업 부팅 재발급이 원천 불가하기 때문.

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

  // NAI 토큰 복원 — OPFS가 축출된 세션에서 DB에 토큰이 없으면 localStorage 미러에서 되살린다.
  // (미러는 아래 invoke 래퍼가 nai:setToken/deleteToken마다 갱신한다.) 렌더러 마운트 전이라
  // 토큰 다이얼로그가 곧바로 "설정됨"을 반영한다.
  {
    const status = await invoke('nai:tokenStatus', undefined)
    if (!status.hasToken) {
      const mirrored = readMirroredToken()
      if (mirrored) await rpcInvoke('_token:restore', { token: mirrored })
    }
  }

  // 렌더러에 노출할 invoke — 토큰 저장/삭제를 localStorage 미러에 반영해 세션 간 지속시킨다.
  const invokeWithTokenMirror = <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    const result = invoke(channel, req)
    if (channel === 'nai:setToken') {
      void result.then((res) => {
        if ((res as { valid?: boolean }).valid) mirrorToken((req as { token: string }).token)
      })
    } else if (channel === 'nai:deleteToken') {
      void result.then(() => clearMirroredToken())
    }
    return result
  }

  const api: NaisApi = { invoke: invokeWithTokenMirror, on, imageUrl: webImageUrl }
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
      importAll: (data: unknown) => rpcInvoke('_backup:importJson', { text: JSON.stringify(data) }),
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

  // Drive 플로팅 패널 (웹 전용, 클라이언트 ID 주입된 빌드에서만) — 렌더러 뒤에 마운트
  if (isDriveConfigured()) {
    mountGdrivePanel()
    // 저장된 토큰으로 세션 복원 — 성공하면 패널을 갱신(_gdrive:needToken은 패널의 새로고침 신호로
    // 재사용)해 "연결됨"으로 반영한다. 만료·부재는 조용히 수동 재연결 상태로 남는다. 부팅은 막지 않는다.
    void restoreDriveSession().then((ok) => {
      if (ok) broadcastRaw('_gdrive:needToken', {})
    })
  }
}

/**
 * 서버 모드 부팅 — 백엔드가 셀프호스트 서버라 로컬 전용 장치가 전부 불필요/무의미하다:
 * 단일 탭 가드(OPFS 없음 — 다중 탭 허용), 토큰 미러(토큰은 서버 DB 상주), storage.persist,
 * Drive 패널(서버 저장이 곧 클라우드 저장), 서비스워커(이미지는 서버가 직접 서빙).
 * P0 공백(서버 미구현 웹 내부 채널): _backup/_refs/_frags/_scenes/_library/_images:readBytes —
 * 해당 가져오기/내보내기 흐름은 호출 시 명확한 에러로 드러난다. P1에서 서버에 이식.
 */
async function startServerMode(serverUrl: string): Promise<void> {
  let ready: { dbVersion: number; channels: string[] }
  try {
    ready = await initServerRpc(serverUrl)
  } catch (e) {
    showServerNotice(e instanceof Error ? e.message : String(e), true)
    return
  }

  registerMainHandlers()

  // 채널 선언표 ↔ 서버 등록 대조 (가드레일 G1) — 서버는 데스크톱 등록표 전체를 재사용하므로
  // 전량 커버가 기대값이다
  if (import.meta.env.DEV) {
    const { verifyChannelCoverage } = await import('./channel-coverage')
    const { hasHandler } = await import('./bus')
    verifyChannelCoverage(ready.channels, hasHandler)
  }

  // 웹검색 모드 기본 숨김 — 로컬 모드와 동일 (Electron <webview> 전용 기능)
  const hidden = await invoke('settings:get', { key: 'ui_hidden_pages' })
  if (hidden.value === null) {
    await invoke('settings:set', { key: 'ui_hidden_pages', value: JSON.stringify(['websearch']) })
  }

  const api: NaisApi = { invoke, on, imageUrl: webImageUrl }
  ;(window as unknown as { nais: NaisApi }).nais = api

  // 끊김/재접속 상태를 상단 배너로 반영 — ipc.ts가 자동 재접속(지수 백오프)을 담당하므로
  // 여기서는 안내만 전환한다. 끊기면 "재접속 중" 배너, 재접속 성공 시 배너 제거.
  const { subscribe } = await import('./bus')
  subscribe('_serverDisconnected', () => {
    showServerNotice('서버 연결이 끊어졌습니다 — 자동 재접속 중…', false)
  })
  subscribe('_serverReconnected', () => {
    hideServerNotice()
  })

  await import('@renderer/main')
  console.log(
    `[web] 서버 모드 — ${serverUrl.replace(/key=[^&]*/, 'key=***')} (채널 ${ready.channels.length}개, DB v${ready.dbVersion})`
  )
}
