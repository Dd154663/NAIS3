/**
 * electron-updater 심 (서버) — 자동 업데이트는 데스크톱 전용.
 * ipc.ts가 updater.ts(startUpdateDownload)를 정적 import하므로 모듈 로드만 무해하게 통과시킨다.
 * 서버 배포 갱신은 셀프호스트 사용자의 몫 (git pull + 재빌드) — update:* 채널은 조용한 no-op.
 */

const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on(): unknown {
    return this
  },
  checkForUpdates: (): Promise<null> => Promise.resolve(null),
  downloadUpdate: (): Promise<string[]> => Promise.resolve([]),
  quitAndInstall: (): void => {}
}

export default { autoUpdater }
