/**
 * Google Drive 연동용 별도 IndexedDB (P6).
 *
 * 메인 DB('nais3-web')와 분리한 이유: 그쪽은 서비스워커가 버전 없이 열어 두는 커넥션이 있어,
 * 스토어 추가로 버전을 올리면 업그레이드가 onblocked로 막힐 수 있다. gdrive 인덱스·큐는
 * 'files'/'thumbs'와 함께 트랜잭션될 필요가 없으므로 독립 DB('nais3-gdrive')로 둔다.
 * (DB 스키마 무변경 원칙 — 데스크톱 백업 호환도 유지)
 *
 * - index: file_path → Drive fileId (원본이 Drive 어디에 있는지)
 * - queue: file_path → { op, mime } 업로드/삭제 재시도 대기열 (오프라인·토큰만료 흡수)
 */

const DB_NAME = 'nais3-gdrive'
const DB_VERSION = 1
type Store = 'index' | 'queue'

export interface QueueEntry {
  path: string
  op: 'put' | 'delete'
  mime: string
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const store of ['index', 'queue'] as const) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('gdrive IndexedDB open 실패'))
  })
  return dbPromise
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('gdrive IndexedDB 요청 실패'))
  })
}

async function get<T>(store: Store, key: string): Promise<T | undefined> {
  const db = await open()
  return request(db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T>)
}

async function put(store: Store, key: string, value: unknown): Promise<void> {
  const db = await open()
  await request(db.transaction(store, 'readwrite').objectStore(store).put(value, key))
}

async function del(store: Store, key: string): Promise<void> {
  const db = await open()
  await request(db.transaction(store, 'readwrite').objectStore(store).delete(key))
}

// ── path ↔ Drive fileId 인덱스 ──────────────────────────────
export const gdriveIndexGet = (path: string): Promise<string | undefined> =>
  get<string>('index', path)
export const gdriveIndexPut = (path: string, fileId: string): Promise<void> =>
  put('index', path, fileId)
export const gdriveIndexDelete = (path: string): Promise<void> => del('index', path)

// ── 업로드/삭제 재시도 대기열 ───────────────────────────────
export const gdriveQueuePut = (entry: QueueEntry): Promise<void> =>
  put('queue', entry.path, entry)
export const gdriveQueueDelete = (path: string): Promise<void> => del('queue', path)

export async function gdriveQueueAll(): Promise<QueueEntry[]> {
  const db = await open()
  return request(db.transaction('queue', 'readonly').objectStore('queue').getAll() as IDBRequest<
    QueueEntry[]
  >)
}
