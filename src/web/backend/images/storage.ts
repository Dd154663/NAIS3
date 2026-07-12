import { randomUUID } from '../../shims/crypto'
import type { DirectorMethod, HistoryItem, ImageMetadata } from '@shared/types'
import { broadcastRaw } from '../../bus'
import { getDb } from '../db'
import { idbDelete, idbKeys, idbPut } from '../idb'
import { makeThumbnail } from '../image-utils'
import { injectNais3Params } from '../png-text'

/**
 * 웹 이미지 스토리지 — src/main/images/storage.ts의 웹 대응.
 * - 원본 bytes: IndexedDB 'files' (경로 규칙: web://images/...)
 * - 썸네일: DB BLOB(데스크톱 동일) + IndexedDB 'thumbs' (서비스워커 폴백 서빙)
 * - 표시: 서비스워커가 /nais-image/?path=... 를 IndexedDB에서 서빙.
 *   SW 미가동 환경(비보안 컨텍스트 등) 대비로 최근 저장분은 오브젝트 URL 캐시 유지.
 * - 자동저장 OFF(memory://)는 데스크톱과 동일한 링버퍼 의미론 (새 세션 시작 시 원본 소멸)
 */

export interface SavedImage {
  id: number
  filePath: string
}

export const MEMORY_PREFIX = 'memory://'
const WEB_ROOT = 'web://images'
const EPHEMERAL_KEEP = 20

const memoryImages = new Map<string, Buffer>()

// ── 오브젝트 URL 캐시 (SW 폴백 + 방금 생성한 이미지의 즉시 표시) ──
// 워커에서 만든 blob URL은 같은 오리진의 메인 문서에서도 유효하다.
// 메인의 imageUrl()이 동기 조회할 수 있도록 캐시/축출을 이벤트로 미러링한다 (_imageUrl* 내부 채널).
const objectUrls = new Map<string, string>()
const OBJECT_URL_KEEP = 40

function dropObjectUrl(filePath: string): void {
  const url = objectUrls.get(filePath)
  if (!url) return
  URL.revokeObjectURL(url)
  objectUrls.delete(filePath)
  broadcastRaw('_imageUrlDrop', { path: filePath })
}

function cacheObjectUrl(filePath: string, bytes: Buffer, mime: string): void {
  dropObjectUrl(filePath)
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
  const url = URL.createObjectURL(new Blob([u8], { type: mime }))
  objectUrls.set(filePath, url)
  broadcastRaw('_imageUrlCache', { path: filePath, url })
  if (objectUrls.size > OBJECT_URL_KEEP) {
    const [oldestKey] = objectUrls.keys()
    dropObjectUrl(oldestKey)
  }
}

export function isMemoryPath(filePath: string): boolean {
  return filePath.startsWith(MEMORY_PREFIX)
}

export function isWebPath(filePath: string): boolean {
  return filePath.startsWith(WEB_ROOT) || isMemoryPath(filePath)
}

export function getMemoryImage(filePath: string): Buffer | null {
  return memoryImages.get(filePath) ?? null
}

export function thumbnailByPath(filePath: string): Buffer | null {
  const row = getDb().prepare('SELECT thumbnail FROM images WHERE file_path = ?').get(filePath) as
    | { thumbnail: Buffer | null }
    | undefined
  return row?.thumbnail ?? null
}

/** IndexedDB에서 원본 bytes 읽기 (SW 없이 백엔드가 직접 읽을 때 — readForSource 등) */
export async function readImageBytes(filePath: string): Promise<Buffer | null> {
  if (isMemoryPath(filePath)) return getMemoryImage(filePath)
  const { idbGet } = await import('../idb')
  const stored = await idbGet<{ bytes: Uint8Array }>('files', filePath)
  return stored ? Buffer.from(stored.bytes) : null
}

function mimeOf(ext: string): string {
  return ext === 'webp' ? 'image/webp' : 'image/png'
}

/** 새 세션 부팅 시 호출 — 지난 세션의 memory:// 원본 정리 (데스크톱 재시작과 동일 의미) */
export async function purgeStaleMemoryFiles(): Promise<void> {
  for (const key of await idbKeys('files')) {
    if (key.startsWith(MEMORY_PREFIX)) await idbDelete('files', key)
  }
}

async function putFile(filePath: string, bytes: Buffer, mime: string): Promise<void> {
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()
  await idbPut('files', filePath, { bytes: u8, mime })
}

async function putThumb(filePath: string, thumb: Buffer): Promise<void> {
  const u8 = new Uint8Array(thumb.buffer, thumb.byteOffset, thumb.byteLength).slice()
  await idbPut('thumbs', filePath, { bytes: u8, mime: 'image/webp' })
}

export async function deleteFileBytes(filePath: string): Promise<void> {
  memoryImages.delete(filePath)
  dropObjectUrl(filePath)
  await idbDelete('files', filePath)
  await idbDelete('thumbs', filePath)
}

/** 자동저장 OFF 저장 — 데스크톱과 동일: 원본은 메모리(+SW 서빙용 IndexedDB), DB엔 썸네일 행 */
export async function saveEphemeralImage(input: {
  png: Buffer
  sentPayload: string
  seed: number
  kind: 't2i' | 'i2i' | 'inpaint'
  format?: 'png' | 'webp'
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): Promise<SavedImage> {
  const ext = input.format ?? 'png'
  const filePath = `${MEMORY_PREFIX}${randomUUID()}.${ext}`
  const buffer =
    ext === 'png' && input.localMetadata
      ? injectNais3Params(input.png, input.localMetadata)
      : input.png
  memoryImages.set(filePath, buffer)
  cacheObjectUrl(filePath, buffer, mimeOf(ext))
  await putFile(filePath, buffer, mimeOf(ext))

  const thumbnail = await makeThumbnail(input.png)
  await putThumb(filePath, thumbnail)
  const db = getDb()
  const result = db
    .prepare(
      'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id) VALUES (?, ?, ?, ?, ?, NULL)'
    )
    .run(
      filePath,
      thumbnail,
      input.kind,
      input.seed,
      payloadWithLocalMetadata(input.sentPayload, input.localMetadata)
    )

  const stale = db
    .prepare(
      `SELECT id, file_path FROM images WHERE file_path LIKE '${MEMORY_PREFIX}%'
       ORDER BY id DESC LIMIT -1 OFFSET ?`
    )
    .all(EPHEMERAL_KEEP) as { id: number; file_path: string }[]
  if (stale.length > 0) {
    for (const s of stale) await deleteFileBytes(s.file_path)
    db.prepare(`DELETE FROM images WHERE id IN (${stale.map(() => '?').join(',')})`).run(
      ...stale.map((s) => s.id)
    )
  }
  return { id: Number(result.lastInsertRowid), filePath }
}

export async function saveGeneratedImage(input: {
  png: Buffer
  sentPayload: string
  seed: number
  kind: 't2i' | 'i2i' | 'inpaint' | 'scene' | 'upscale' | 'director' | 'mosaic' | DirectorMethod
  sceneId?: number
  format?: 'png' | 'webp'
  sceneName?: string
  scenePresetName?: string
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): Promise<SavedImage> {
  const now = new Date()
  const ext = input.format ?? 'png'
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)

  // 웹은 실제 디렉터리가 없으므로 경로는 표시/구분용 논리 경로다.
  // 씬은 데스크톱 계층(<프리셋>/<씬>)을 유지하되 파일명은 타임스탬프로 충돌 회피
  // (데스크톱의 "씬이름_N" 넘버링은 디렉터리 목록이 필요해 웹에선 생략).
  const safe = (s: string): string => s.replace(/[/\\:*?"<>|]/g, '_').trim()
  let filePath: string
  if (input.sceneName) {
    const preset = safe(input.scenePresetName ?? '') || '기본'
    const scene = safe(input.sceneName) || `씬-${input.sceneId}`
    filePath = `${WEB_ROOT}/scene/${preset}/${scene}/${scene}_${stamp}.${ext}`
  } else {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    filePath = `${WEB_ROOT}/${month}/NAIS3_${stamp}_${input.seed}.${ext}`
  }

  const fileBuffer =
    ext === 'png' && input.localMetadata
      ? injectNais3Params(input.png, input.localMetadata)
      : input.png
  cacheObjectUrl(filePath, fileBuffer, mimeOf(ext))
  await putFile(filePath, fileBuffer, mimeOf(ext))

  const thumbnail = await makeThumbnail(input.png)
  await putThumb(filePath, thumbnail)

  const result = getDb()
    .prepare(
      'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, scene_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      filePath,
      thumbnail,
      input.kind,
      input.seed,
      payloadWithLocalMetadata(input.sentPayload, input.localMetadata),
      input.sceneId ?? null
    )

  return { id: Number(result.lastInsertRowid), filePath }
}

function payloadWithLocalMetadata(
  sentPayload: string,
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
): string {
  if (!localMetadata) return sentPayload
  try {
    return JSON.stringify({ ...JSON.parse(sentPayload), nais3: localMetadata })
  } catch {
    return sentPayload
  }
}

export function listImages(limit: number, offset: number): { items: HistoryItem[]; total: number } {
  const db = getDb()
  const total = (db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number }).c
  const rows = db
    .prepare(
      `SELECT id, file_path, thumbnail, kind, seed, created_at
       FROM images ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as {
    id: number
    file_path: string
    thumbnail: Buffer | null
    kind: string
    seed: number | null
    created_at: string
  }[]

  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      thumbnail: r.thumbnail ? r.thumbnail.toString('base64') : '',
      kind: r.kind,
      seed: r.seed,
      createdAt: r.created_at
    }))
  }
}

export function getImagePayload(id: number): string | null {
  const row = getDb().prepare('SELECT payload_json FROM images WHERE id = ?').get(id) as
    | { payload_json: string }
    | undefined
  return row?.payload_json ?? null
}

export function setImageFavorite(id: number, favorite: boolean): void {
  getDb().prepare('UPDATE images SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id)
}

/**
 * 이미지 삭제 — 웹은 "기록만 삭제" 시에도 blob을 지운다.
 * (데스크톱의 파일 보존은 탐색기로 접근 가능해 의미가 있지만, 웹 IndexedDB의
 * 고아 blob은 사용자가 접근할 수 없는 용량 누수일 뿐이다)
 */
export async function deleteImage(id: number): Promise<void> {
  const row = getDb().prepare('SELECT file_path FROM images WHERE id = ?').get(id) as
    | { file_path: string }
    | undefined
  getDb().prepare('DELETE FROM images WHERE id = ?').run(id)
  if (row) await deleteFileBytes(row.file_path)
}

export async function clearAllImages(): Promise<number> {
  const rows = getDb().prepare('SELECT file_path FROM images').all() as { file_path: string }[]
  const { changes } = getDb().prepare('DELETE FROM images').run()
  for (const r of rows) await deleteFileBytes(r.file_path)
  return changes
}
