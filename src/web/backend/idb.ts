/**
 * IndexedDB 최소 프라미스 래퍼.
 * - kv: DB 스냅샷(sql.js export)·백업 등 작은 키-값
 * - files: 생성 이미지 원본 bytes (file_path → { bytes, mime })
 * - thumbs: 썸네일 bytes (원본 만료 시 서비스워커 폴백 서빙용)
 *
 * 스토어 구조는 public/sw.js와 공유되므로 이름을 바꾸면 함께 바꿔야 한다.
 */

export const IDB_NAME = 'nais3-web'
export const IDB_VERSION = 1
export type StoreName = 'kv' | 'files' | 'thumbs'

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of ['kv', 'files', 'thumbs'] as const) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open 실패'))
  })
  return dbPromise
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB 요청 실패'))
  })
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  return request(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T>)
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open()
  await request(db.transaction(store, 'readwrite').objectStore(store).put(value, key))
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  const db = await open()
  await request(db.transaction(store, 'readwrite').objectStore(store).delete(key))
}

export async function idbKeys(store: StoreName): Promise<string[]> {
  const db = await open()
  const keys = await request(db.transaction(store, 'readonly').objectStore(store).getAllKeys())
  return keys.map(String)
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await open()
  await request(db.transaction(store, 'readwrite').objectStore(store).clear())
}
