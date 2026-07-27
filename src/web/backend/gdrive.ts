/**
 * Google Drive REST 클라이언트 (P6, 워커 전용).
 *
 * 워커에서 fetch로 Drive v3 API를 직접 호출한다 (drive.file 스코프 — 이 앱이 만든 파일만 접근).
 * 액세스 토큰은 메인 스레드의 GIS(gdrive-auth.ts)가 발급해 `_gdrive:setToken`으로 밀어넣는다.
 * 토큰이 없거나 만료면 요청은 needsAuth로 신호하고, 상위(P6-4 정책)가 대기열로 흡수한다 —
 * 생성 경로가 Drive에 동기적으로 의존하지 않게 한다.
 *
 * 파일 배치: 논리 경로(web://images/<...>/name.ext)의 디렉터리 구조를 Drive에
 * `NAIS3/<...>/name.ext` 폴더 트리로 미러링한다 (folderCache로 반복 업로드 비용 절감).
 */
import {
  gdriveIndexDelete,
  gdriveIndexGet,
  gdriveIndexPut
} from './gdrive-store'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ROOT_NAME = 'NAIS3'
const WEB_IMAGES_PREFIX = 'web://images/'

export class GDriveAuthError extends Error {
  constructor(message = 'Drive 인증 필요') {
    super(message)
    this.name = 'GDriveAuthError'
  }
}

let accessToken: string | null = null
let tokenExpiresAt = 0 // epoch ms
let uploadCounter = 0

/** 메인의 GIS가 발급한 토큰 주입 (`_gdrive:setToken`) */
export function setDriveToken(token: string | null, expiresAt: number): void {
  accessToken = token
  tokenExpiresAt = expiresAt
  if (!token) {
    folderCache.clear()
    rootFolderId = null
  }
}

/** 유효 토큰 보유 여부 (만료 60초 여유) */
export function hasDriveToken(): boolean {
  return accessToken !== null && Date.now() < tokenExpiresAt - 60_000
}

function authHeaders(extra?: Record<string, string>): Headers {
  if (!hasDriveToken()) throw new GDriveAuthError()
  const h = new Headers(extra)
  h.set('Authorization', `Bearer ${accessToken}`)
  return h
}

/** Google API 에러 본문에서 사람이 읽을 메시지 추출 */
async function driveErrorMsg(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: { message?: string } }
    if (body?.error?.message) return `${fallback}: ${body.error.message}`
  } catch {
    /* 본문이 JSON이 아니면 fallback */
  }
  return fallback
}

/**
 * 401만 인증 만료로 승격(토큰 폐기 → 상위가 재인증·대기열 재시도).
 * 403은 스코프/쿼터/Drive API 미활성 등 재인증으로 안 풀리는 문제라 토큰을 유지하고
 * 상세 메시지를 그대로 던진다. 404는 통과(호출부가 처리).
 */
async function driveFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.ok || res.status === 404) return res
  if (res.status === 401) {
    accessToken = null
    throw new GDriveAuthError(await driveErrorMsg(res, 'Drive 인증 만료(401)'))
  }
  throw new Error(await driveErrorMsg(res, `Drive 오류 ${res.status}`))
}

// ── 폴더 확보 (경로 세그먼트 → Drive 폴더 트리) ─────────────
const folderCache = new Map<string, string>() // `${parentId}/${name}` → folderId
let rootFolderId: string | null = null

function escapeQ(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  const cacheKey = `${parentId}/${name}`
  const cached = folderCache.get(cacheKey)
  if (cached) return cached

  const q =
    `name='${escapeQ(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and ` +
    `'${parentId}' in parents`
  const listRes = await driveFetch(
    `${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`,
    { headers: authHeaders() }
  )
  if (listRes.ok) {
    const data = (await listRes.json()) as { files?: { id: string }[] }
    const existing = data.files?.[0]?.id
    if (existing) {
      folderCache.set(cacheKey, existing)
      return existing
    }
  }

  const createRes = await driveFetch(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
  })
  if (!createRes.ok) throw new Error(`Drive 폴더 생성 실패: ${createRes.status}`)
  const created = (await createRes.json()) as { id: string }
  folderCache.set(cacheKey, created.id)
  return created.id
}

async function ensureRoot(): Promise<string> {
  if (rootFolderId) return rootFolderId
  const q = `name='${ROOT_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`
  const listRes = await driveFetch(
    `${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&pageSize=1`,
    { headers: authHeaders() }
  )
  if (listRes.ok) {
    const data = (await listRes.json()) as { files?: { id: string }[] }
    const existing = data.files?.[0]?.id
    if (existing) {
      rootFolderId = existing
      return existing
    }
  }
  const createRes = await driveFetch(`${DRIVE_FILES}?fields=id`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: ROOT_NAME, mimeType: FOLDER_MIME })
  })
  if (!createRes.ok) throw new Error(`Drive 루트 폴더 생성 실패: ${createRes.status}`)
  rootFolderId = ((await createRes.json()) as { id: string }).id
  return rootFolderId
}

/** 논리 경로 → { 부모 폴더 id, 파일명 } */
async function resolveParent(path: string): Promise<{ parentId: string; filename: string }> {
  const rel = path.startsWith(WEB_IMAGES_PREFIX) ? path.slice(WEB_IMAGES_PREFIX.length) : path
  const segments = rel.split('/').filter(Boolean)
  const filename = segments.pop() ?? 'image'
  let parent = await ensureRoot()
  for (const seg of segments) parent = await findOrCreateFolder(seg, parent)
  return { parentId: parent, filename }
}

function multipartBody(
  metadata: object,
  mime: string,
  bytes: Uint8Array
): { blob: Blob; boundary: string } {
  const boundary = `nais3-${uploadCounter++}-${bytes.byteLength}-boundary`
  const head =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  const tail = `\r\n--${boundary}--`
  return { blob: new Blob([head, bytes.slice(), tail]), boundary }
}

// ── 공개 API (StorageProvider가 P6-4에서 감싸 쓸 원자 연산) ──

/** 원본 업로드 (기존 매핑 있으면 내용 교체). 반환: Drive fileId */
export async function driveUpload(path: string, bytes: Uint8Array, mime: string): Promise<string> {
  authHeaders() // 토큰 사전 확인 (없으면 GDriveAuthError)
  const existingId = await gdriveIndexGet(path)
  const { parentId, filename } = await resolveParent(path)
  // 신규는 부모 폴더 지정해 생성, 기존은 내용만 교체(parents 불변)
  const metadata: { name: string; parents?: string[] } = existingId
    ? { name: filename }
    : { name: filename, parents: [parentId] }
  const url = existingId
    ? `${DRIVE_UPLOAD}/${existingId}?uploadType=multipart&fields=id`
    : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`
  const method: 'POST' | 'PATCH' = existingId ? 'PATCH' : 'POST'

  const { blob, boundary } = multipartBody(metadata, mime, bytes)
  const res = await driveFetch(url, {
    method,
    headers: authHeaders({ 'Content-Type': `multipart/related; boundary=${boundary}` }),
    body: blob
  })
  if (!res.ok) throw new Error(`Drive 업로드 실패: ${res.status}`)
  const fileId = ((await res.json()) as { id: string }).id
  await gdriveIndexPut(path, fileId)
  return fileId
}

/** 원본 다운로드. 매핑 없거나 404(원격 삭제됨)면 null */
export async function driveDownload(path: string): Promise<Uint8Array | null> {
  const fileId = await gdriveIndexGet(path)
  if (!fileId) return null
  const res = await driveFetch(`${DRIVE_FILES}/${fileId}?alt=media`, { headers: authHeaders() })
  if (res.status === 404) {
    await gdriveIndexDelete(path)
    return null
  }
  if (!res.ok) throw new Error(`Drive 다운로드 실패: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** 원본 삭제 (매핑 없으면 no-op, 404는 성공 취급) */
export async function driveDelete(path: string): Promise<void> {
  const fileId = await gdriveIndexGet(path)
  if (!fileId) return
  const res = await driveFetch(`${DRIVE_FILES}/${fileId}`, {
    method: 'DELETE',
    headers: authHeaders()
  })
  if (!res.ok && res.status !== 404) throw new Error(`Drive 삭제 실패: ${res.status}`)
  await gdriveIndexDelete(path)
}
