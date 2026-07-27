import type { IpcInvokeMap } from '@shared/types'

/**
 * 채널 커버리지 선언표 (유지보수 가드레일 G1).
 *
 * IpcInvokeMap의 모든 채널이 웹에서 어느 쪽(워커/메인 스레드)에 구현돼 있는지 선언한다.
 * `satisfies Record<keyof IpcInvokeMap, ...>` 덕분에 원작 shared/types.ts에 채널이
 * 추가/삭제되면 `npm run typecheck:webapp`이 **이 파일에서 채널명을 지목하며 실패**한다 —
 * 새 채널이 런타임 "미구현 채널" 에러로 뒤늦게 발견되는 것을 컴파일 타임으로 앞당기는 장치.
 *
 * 실패 시 대응: 새 채널의 핸들러를 워커(src/web/worker/handlers.ts) 또는
 * 메인(src/web/main-handlers.ts)에 구현하고 여기에 한 줄 추가한다.
 * 선언과 실제 등록의 일치는 DEV 부팅 시 verifyChannelCoverage()가 검사한다.
 */

export type ChannelOwner = 'worker' | 'main'

export const CHANNEL_OWNER = {
  'db:status': 'worker',
  'app:version': 'worker',

  'nai:verifyToken': 'worker',
  'nai:setToken': 'worker',
  'nai:tokenStatus': 'worker',
  'nai:revealToken': 'worker',
  'nai:deleteToken': 'worker',
  'nai:balance': 'worker',
  'nai:anlasUsage': 'worker',

  'queue:enqueue': 'worker',
  'queue:cancel': 'worker',
  'queue:status': 'worker',
  'gen:setDelay': 'worker',

  'images:list': 'worker',
  'images:payload': 'worker',
  'images:readForSource': 'worker',
  'images:setFavorite': 'worker',
  'images:delete': 'worker',
  'images:clearAll': 'worker',
  'images:saveLocal': 'worker',
  'images:upscale': 'worker',
  'images:readMetadata': 'worker',
  'images:analyzeArtists': 'worker', // HF Space 호출뿐 — @gradio/client 브라우저 빌드 재사용
  'director:run': 'worker',
  'images:showInFolder': 'main', // 웹은 no-op (탐색기 없음)
  'images:saveAs': 'main', // 다운로드 (바이트는 _images:readBytes로 워커에서)
  'images:copy': 'main', // 클립보드

  'settings:get': 'worker',
  'settings:set': 'worker',
  'settings:getSaveDir': 'worker',
  'settings:pickSaveDir': 'worker',
  'settings:resetSaveDir': 'worker',

  'window:control': 'main',
  'window:setBackground': 'main',
  'update:start': 'main', // 웹에선 reload
  'notify:done': 'main',

  'chars:list': 'worker',
  'chars:create': 'worker',
  'chars:update': 'worker',
  'chars:delete': 'worker',
  'chars:duplicate': 'worker',
  'chars:pickThumbnail': 'main', // 파일 picker
  'chars:clearThumbnail': 'worker',
  'chars:reorder': 'worker',
  'chars:folderCreate': 'worker',
  'chars:folderRename': 'worker',
  'chars:folderCollapse': 'worker',
  'chars:folderColor': 'worker',
  'chars:folderDelete': 'worker',

  'frags:list': 'worker',
  'frags:create': 'worker',
  'frags:update': 'worker',
  'frags:delete': 'worker',
  'frags:duplicate': 'worker',
  'frags:importTxt': 'main', // 파일 picker
  'frags:exportTxt': 'main', // 다운로드
  'frags:exportAll': 'main', // 다운로드
  'frags:resetSequential': 'worker',
  'frags:reorder': 'worker',
  'frags:folderCreate': 'worker',
  'frags:folderRename': 'worker',
  'frags:folderCollapse': 'worker',
  'frags:folderColor': 'worker',
  'frags:folderDelete': 'worker',

  'tags:search': 'worker',
  'tokens:count': 'worker',

  'scenePresets:list': 'worker',
  'scenePresets:create': 'worker',
  'scenePresets:rename': 'worker',
  'scenePresets:delete': 'worker',
  'scenePresets:reorder': 'worker',
  'scenePresets:setCharacters': 'worker',
  'scenePresets:setDefaultResolution': 'worker',

  'promptPresets:list': 'worker',
  'promptPresets:create': 'worker',
  'promptPresets:update': 'worker',
  'promptPresets:delete': 'worker',
  'promptPresets:reorder': 'worker',

  'backup:export': 'main', // 다운로드
  'backup:import': 'main', // 파일 picker

  'scenes:list': 'worker',
  'scenes:create': 'worker',
  'scenes:get': 'worker',
  'scenes:update': 'worker',
  'scenes:duplicate': 'worker',
  'scenes:delete': 'worker',
  'scenes:reorder': 'worker',
  'scenes:setReserveAll': 'worker',
  'scenes:adjustReserveAll': 'worker',
  'scenes:setReserves': 'worker',
  'scenes:reservedTotal': 'worker',
  'scenes:bulkMove': 'worker',
  'scenes:bulkDelete': 'worker',
  'scenes:bulkSetResolution': 'worker',
  'scenes:bulkClearFavorites': 'worker',
  'scenes:bulkClearImages': 'worker',
  'scenes:bulkExportZip': 'main', // 다운로드
  'scenes:images': 'worker',
  'scenes:deleteNonFavorites': 'worker',
  'scenes:openFolder': 'main', // 웹은 no-op
  'scenes:exportJson': 'main', // 다운로드
  'scenes:importJson': 'main', // 파일 picker
  'scenes:exportZip': 'main', // 다운로드

  'vibes:list': 'worker',
  'vibes:add': 'main', // 파일 picker
  'vibes:update': 'worker',
  'vibes:delete': 'worker',
  'vibes:duplicate': 'worker',
  'vibes:reorder': 'worker',
  'vibes:folderCreate': 'worker',
  'vibes:folderRename': 'worker',
  'vibes:folderCollapse': 'worker',
  'vibes:folderColor': 'worker',
  'vibes:folderDelete': 'worker',

  'crefs:list': 'worker',
  'crefs:add': 'main', // 파일 picker
  'crefs:update': 'worker',
  'crefs:delete': 'worker',
  'crefs:duplicate': 'worker',
  'crefs:reorder': 'worker',
  'crefs:folderCreate': 'worker',
  'crefs:folderRename': 'worker',
  'crefs:folderCollapse': 'worker',
  'crefs:folderColor': 'worker',
  'crefs:folderDelete': 'worker',

  'library:list': 'worker',
  'library:import': 'main', // 파일 picker
  'library:importPaths': 'worker',
  'library:importImages': 'worker',
  'library:delete': 'worker',
  'library:reorder': 'worker',
  'library:stackCreate': 'worker',
  'library:stackRename': 'worker',
  'library:stackDelete': 'worker',
  'library:stackSet': 'worker',
  'library:export': 'main' // 폴더 복사 → 연번 ZIP 다운로드 (데이터는 _library:exportZipData)
} as const satisfies Record<keyof IpcInvokeMap, ChannelOwner>

/**
 * 선언(표) ↔ 실제 등록 대조 — DEV 부팅 시 bootstrap이 호출.
 * 'worker' 선언인데 워커 미등록 / 'main' 선언인데 메인 미등록이면 console.error.
 * (표만으로는 "선언됐지만 핸들러 등록 누락"을 잡지 못하는 구멍을 메운다)
 */
export function verifyChannelCoverage(
  workerChannels: string[],
  hasMainHandler: (channel: string) => boolean
): void {
  const workerSet = new Set(workerChannels)
  for (const [channel, owner] of Object.entries(CHANNEL_OWNER)) {
    const registered = owner === 'worker' ? workerSet.has(channel) : hasMainHandler(channel)
    if (!registered) {
      console.error(
        `[web] 채널 커버리지 불일치: '${channel}'은 ${owner} 담당으로 선언됐지만 등록되지 않음 (channel-coverage.ts)`
      )
    }
  }
}
