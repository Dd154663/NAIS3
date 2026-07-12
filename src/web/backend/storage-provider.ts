/**
 * 원본 이미지 bytes의 저장 백엔드 추상화 (P6).
 *
 * 생성 이미지의 "원본"(썸네일 아님)이 어디에 사는지를 이 인터페이스 하나로 갈아끼운다:
 * - 기본(idb): 지금까지처럼 IndexedDB 'files' 스토어에 로컬 저장
 * - Google Drive(P6-2~): 원본은 Drive, 로컬엔 LRU 캐시 — 같은 인터페이스로 감싼다
 *
 * 이 추상화가 다루는 것은 durable한 web:// 원본뿐이다. 다음 둘은 밖(storage.ts)에서 계속 직접 다룬다:
 * - 썸네일('thumbs'): 항상 로컬 — 서비스워커 폴백 서빙·히스토리 그리드용
 * - memory:// 임시 원본: 세션 링버퍼라 외부 저장 대상이 아님 (항상 로컬 idb)
 */
import { idbDelete, idbGet, idbPut } from './idb'

export interface StorageProvider {
  /** 원본 bytes 저장 (path = file_path, 예: web://images/...) */
  put(path: string, bytes: Uint8Array, mime: string): Promise<void>
  /** 원본 bytes 조회 (없으면 null) */
  get(path: string): Promise<Uint8Array | null>
  /** 원본 bytes 삭제 */
  delete(path: string): Promise<void>
}

/** 기존 동작 그대로 — IndexedDB 'files' 스토어에 로컬 저장 */
export const idbStorageProvider: StorageProvider = {
  async put(path, bytes, mime) {
    await idbPut('files', path, { bytes, mime })
  },
  async get(path) {
    const stored = await idbGet<{ bytes: Uint8Array }>('files', path)
    return stored ? stored.bytes : null
  },
  async delete(path) {
    await idbDelete('files', path)
  }
}

let active: StorageProvider = idbStorageProvider

export function getStorageProvider(): StorageProvider {
  return active
}

/** Drive 등 다른 백엔드로 교체 (P6-4에서 사용). idbStorageProvider로 되돌리면 로컬 전용 복귀 */
export function setStorageProvider(provider: StorageProvider): void {
  active = provider
}
