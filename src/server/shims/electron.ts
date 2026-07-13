/**
 * electron 심 (서버) — 재사용하는 src/main 모듈이 import하는 표면만 Node로 대체.
 * 빌드 시점(esbuild alias)에만 바꿔치기하므로 원본 코드는 그대로다.
 * 웹 심(src/web/shims/electron.ts)과 같은 원칙: 서버에서 의미 없는 API는 호출 시점에
 * 명확히 실패한다 — 다이얼로그/클립보드 채널은 클라이언트(main-handlers)가 대체하므로
 * 여기 도달하면 배선 누락 버그다.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emitEvent } from '../event-hub'
import { register } from '../registry'

/** 데이터 루트 — DB·이미지·키가 전부 이 아래 (셀프호스트 백업 = 이 폴더 복사) */
export const DATA_DIR = process.env.NAIS3_DATA_DIR ?? join(homedir(), '.nais3-server')
/** resources/(tags.json, t5_tokenizer.json) 위치 — 기본은 실행 위치 */
const APP_ROOT = process.env.NAIS3_APP_ROOT ?? process.cwd()

export const app = {
  getAppPath: (): string => APP_ROOT,
  getPath: (name: string): string =>
    name === 'pictures' ? join(DATA_DIR, 'pictures') : join(DATA_DIR, 'userData'),
  getVersion: (): string => __APP_VERSION__
}

function unsupported(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`[server] electron.${name}은 서버에서 지원되지 않습니다`)
  }
}

/** ipcMain.handle → 서버 레지스트리. 원본 ipc.ts의 handle 래퍼가 그대로 동작한다 */
export const ipcMain = {
  handle: (channel: string, handler: (event: unknown, req: unknown) => unknown): void => {
    register(channel, handler)
  }
}

/**
 * 가짜 BrowserWindow — broadcast(webContents.send)를 이벤트 허브로 흘리고,
 * 창 조작(window:control 등)은 무해한 no-op. isFocused()=true라 notify:done이
 * 조기 반환한다 (서버엔 네이티브 알림이 없다 — 완료 알림은 P3 Web Push 몫).
 */
class FakeWindow {
  webContents = {
    send: (channel: string, payload: unknown): void => {
      emitEvent(channel, payload)
    }
  }
  isFocused(): boolean {
    return true
  }
  isMinimized(): boolean {
    return false
  }
  isMaximized(): boolean {
    return false
  }
  restore(): void {
    /* noop — 서버엔 창이 없다 */
  }
  show(): void {
    /* noop */
  }
  focus(): void {
    /* noop */
  }
  minimize(): void {
    /* noop */
  }
  maximize(): void {
    /* noop */
  }
  unmaximize(): void {
    /* noop */
  }
  close(): void {
    /* noop */
  }
  setBackgroundColor(): void {
    /* noop */
  }
}

const theWindow = new FakeWindow()

export class BrowserWindow {
  static getAllWindows(): FakeWindow[] {
    return [theWindow]
  }
  static getFocusedWindow(): FakeWindow | null {
    return null
  }
}

export const dialog = {
  showOpenDialog: unsupported('dialog.showOpenDialog'),
  showSaveDialog: unsupported('dialog.showSaveDialog'),
  showErrorBox: (title: string, content: string): void => {
    console.error(`[server] ${title}: ${content}`)
  }
}

export const shell = {
  openPath: unsupported('shell.openPath'),
  openExternal: unsupported('shell.openExternal'),
  showItemInFolder: unsupported('shell.showItemInFolder')
}

export const clipboard = { writeImage: unsupported('clipboard.writeImage') }
export const nativeImage = {
  createFromBuffer: unsupported('nativeImage.createFromBuffer'),
  createFromPath: unsupported('nativeImage.createFromPath')
}

/** notify:done은 isFocused()=true로 조기 반환하므로 isSupported까지 오지 않지만, 안전망 */
export class Notification {
  static isSupported(): boolean {
    return false
  }
  on(): void {
    /* noop */
  }
  show(): void {
    /* noop */
  }
}

/**
 * safeStorage 대응 — OS 키체인 대신 데이터 디렉터리의 키 파일로 AES-256-GCM.
 * 데스크톱과 동일하게 "DB만 뜯어서는 토큰 평문이 안 보이는" 수준을 유지한다
 * (키 파일과 DB가 같은 디스크라 위협 모델은 더 약하다 — 접근 권한 0600으로 보완).
 */
let cachedKey: Buffer | null = null

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey
  const dir = join(DATA_DIR, 'userData')
  const keyPath = join(dir, 'secret.key')
  if (!existsSync(keyPath)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 })
  }
  cachedKey = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'hex')
  return cachedKey
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => true,
  encryptString: (plain: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), enc])
  },
  decryptString: (buf: Buffer): string => {
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const enc = buf.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf-8')
  }
}
