/**
 * Drive 보관 정책 프로바이더 (P6-4, 워커).
 *
 * StorageProvider를 구현해 "외부 원본(Drive) + 로컬 LRU 캐시" 정책을 실현한다.
 * 핵심 불변식: **생성 경로는 Drive에 절대 동기 의존하지 않는다** —
 * 저장은 항상 로컬 먼저 성공시키고, Drive 업로드 실패/오프라인/토큰만료는 대기열로 흡수한다.
 *
 * - put: 로컬 idb 'files'에 먼저 저장(SW 즉시 서빙) → Drive 업로드 시도(실패 시 큐) → LRU 정리
 * - get: 로컬 히트면 반환, 미스면 Drive에서 받아 로컬 재적재(썸네일은 이 경로와 무관, 항상 DB)
 * - delete: 로컬 + Drive 양쪽 (Drive 실패 시 삭제도 큐로)
 * - LRU: 업로드 확정(gdrive-index有)되고 큐에 없는 원본만 축출 대상. 최근 N장은 로컬 풀해상도 유지
 */
import { idbKeys } from './idb'
import { broadcastRaw } from '../bus'
import { idbStorageProvider, type StorageProvider } from './storage-provider'
import {
  GDriveAuthError,
  driveDelete,
  driveDownload,
  driveUpload,
  hasDriveToken
} from './gdrive'
import {
  gdriveIndexGet,
  gdriveLruGet,
  gdriveLruSet,
  gdriveQueueAll,
  gdriveQueueDelete,
  gdriveQueuePut
} from './gdrive-store'

/** 로컬에 풀해상도로 유지할 최근 원본 수 기본값 (초과분은 blob 축출, 썸네일·Drive 원본은 유지) */
const DEFAULT_CACHE_LIMIT = 40
const WEB_PREFIX = 'web://'

let cacheLimit = DEFAULT_CACHE_LIMIT
/** 패널/설정에서 로컬 보관 매수 조정 (최소 1) */
export function setLocalCacheLimit(n: number): void {
  if (Number.isFinite(n) && n >= 1) cacheLimit = Math.floor(n)
}
export function getLocalCacheLimit(): number {
  return cacheLimit
}

function guessMime(path: string): string {
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.txt')) return 'text/plain'
  return 'image/png'
}

/** 토큰 만료/부재로 인증이 필요할 때 메인에 무팝업 재발급 요청 */
function requestReauth(): void {
  broadcastRaw('_gdrive:needToken', {})
}

async function touchLru(path: string): Promise<void> {
  const lru = await gdriveLruGet()
  await gdriveLruSet([...lru.filter((p) => p !== path), path])
}

async function dropFromLru(path: string): Promise<void> {
  const lru = await gdriveLruGet()
  if (lru.includes(path)) await gdriveLruSet(lru.filter((p) => p !== path))
}

/** 로컬 원본 수가 한도 초과면, 오래된 순으로 "업로드 확정 && 큐에 없음"인 것만 blob 축출 */
async function evictIfNeeded(): Promise<void> {
  const localKeys = (await idbKeys('files')).filter((k) => k.startsWith(WEB_PREFIX))
  if (localKeys.length <= cacheLimit) return

  const lru = await gdriveLruGet()
  const queued = new Set((await gdriveQueueAll()).map((q) => q.path))
  // 오래된 순서: LRU에 없는 로컬(순서 미상)을 가장 오래된 것으로 앞세우고, 그다음 LRU 순
  const localSet = new Set(localKeys)
  const order = [
    ...localKeys.filter((k) => !lru.includes(k)),
    ...lru.filter((k) => localSet.has(k))
  ]

  let excess = localKeys.length - cacheLimit
  const survivingLru = [...lru]
  for (const path of order) {
    if (excess <= 0) break
    const uploaded = await gdriveIndexGet(path)
    if (!uploaded || queued.has(path)) continue // 아직 Drive에 없으면 핀 고정
    await idbStorageProvider.delete(path) // 로컬 blob만 제거 (썸네일은 DB에 잔존)
    const i = survivingLru.indexOf(path)
    if (i >= 0) survivingLru.splice(i, 1)
    excess--
  }
  await gdriveLruSet(survivingLru)
}

export const driveStorageProvider: StorageProvider = {
  async put(path, bytes, mime) {
    // 로컬 먼저 저장 — 생성은 여기서 성공. 업로드 "의도"를 영속 큐에 기록하므로 탭이 닫혀도 유실 없음.
    // 실제 업로드는 백그라운드 배수로 — 생성 경로가 네트워크에 블로킹·의존하지 않게 한다.
    await idbStorageProvider.put(path, bytes, mime)
    await touchLru(path)
    await gdriveQueuePut({ path, op: 'put', mime })
    await evictIfNeeded() // 큐에 있는 신규분은 핀 고정 — 오래된 업로드분만 blob 축출
    void drainDriveQueue() // 백그라운드 업로드 (실패 시 큐에 남아 재시도)
  },

  async get(path) {
    const local = await idbStorageProvider.get(path)
    if (local) {
      await touchLru(path)
      return local
    }
    // 로컬 미스(축출됨) → Drive에서 복원
    try {
      const remote = await driveDownload(path)
      if (remote) {
        await idbStorageProvider.put(path, remote, guessMime(path))
        await touchLru(path)
        await evictIfNeeded()
        return remote
      }
    } catch (e) {
      if (e instanceof GDriveAuthError) requestReauth()
    }
    return null
  },

  async delete(path) {
    await idbStorageProvider.delete(path)
    await dropFromLru(path)
    try {
      await driveDelete(path)
      await gdriveQueueDelete(path)
    } catch (e) {
      await gdriveQueuePut({ path, op: 'delete', mime: '' })
      if (e instanceof GDriveAuthError) requestReauth()
    }
  }
}

let draining = false

/**
 * 대기열 배수 — put(백그라운드)·토큰 주입·온라인 복귀·부팅 시 호출.
 * put 항목은 로컬 원본을 다시 읽어 업로드(로컬에서 사라졌으면 스킵 — 이미 업로드돼 축출됐다는 뜻),
 * delete 항목은 Drive 삭제. 성공분만 큐에서 제거한다.
 * 동시 실행 방지(draining 가드) + 진전이 있는 한 재스냅샷 반복(배수 중 추가분도 흡수).
 */
export async function drainDriveQueue(): Promise<{ done: number; left: number }> {
  if (draining) return { done: 0, left: (await gdriveQueueAll()).length }
  if (!hasDriveToken()) {
    requestReauth()
    return { done: 0, left: (await gdriveQueueAll()).length }
  }
  draining = true
  let done = 0
  try {
    for (;;) {
      const batch = await gdriveQueueAll()
      if (batch.length === 0) break
      let progressed = false
      let authFailed = false
      for (const entry of batch) {
        try {
          if (entry.op === 'delete') {
            await driveDelete(entry.path)
          } else {
            const bytes = await idbStorageProvider.get(entry.path)
            if (bytes) await driveUpload(entry.path, bytes, entry.mime)
          }
          await gdriveQueueDelete(entry.path)
          done++
          progressed = true
        } catch (e) {
          if (e instanceof GDriveAuthError) {
            requestReauth()
            authFailed = true
            break // 토큰 문제면 재발급 후 재시도
          }
          // 일시 오류 — 이 항목은 큐에 남겨두고 다음으로
        }
      }
      if (authFailed || !progressed) break // 무한루프 방지: 진전 없으면 중단
    }
  } finally {
    draining = false
  }
  return { done, left: (await gdriveQueueAll()).length }
}
