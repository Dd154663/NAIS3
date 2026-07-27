/**
 * electron shim — 재사용하는 src/main 모듈들이 import하는 표면만 제공.
 * 웹에서 의미 없는 API는 호출 시점에 명확히 실패한다 (다이얼로그 기반 흐름은
 * 웹 백엔드가 채널 단위로 대체 구현하므로 여기 도달하면 등록 누락 버그).
 */

export const app = {
  getAppPath: (): string => '/app',
  getPath: (_name: string): string => '/app/userData',
  getVersion: (): string => __APP_VERSION__
}

function unsupported(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`[web] electron.${name}은 웹에서 지원되지 않습니다`)
  }
}

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): BrowserWindow | null {
    return null
  }
}

export const dialog = {
  showOpenDialog: unsupported('dialog.showOpenDialog'),
  showSaveDialog: unsupported('dialog.showSaveDialog'),
  showErrorBox: (title: string, content: string): void => {
    console.error(`[web] ${title}: ${content}`)
  }
}

export const shell = {
  openPath: unsupported('shell.openPath'),
  openExternal: (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  },
  showItemInFolder: unsupported('shell.showItemInFolder')
}

export const clipboard = { writeImage: unsupported('clipboard.writeImage') }
export const nativeImage = {
  createFromBuffer: unsupported('nativeImage.createFromBuffer'),
  createFromPath: unsupported('nativeImage.createFromPath')
}
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: unsupported('safeStorage.encryptString'),
  decryptString: unsupported('safeStorage.decryptString')
}
