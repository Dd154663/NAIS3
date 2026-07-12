import type { CharacterReferenceOptions, VibeOptions } from '@main/nai/payload'
import { ENDPOINTS } from '@main/nai/endpoints'
import { enabledCharRefRows, enabledVibeRows, saveVibeEncoding } from '@main/refs/repo'
import { randomUUID } from '../shims/crypto'
import { getDb } from './db'
import { makeCoverThumbnail, resizeContainPng } from './image-utils'
import { deleteFileBytes, readImageBytes } from './images/storage'
import { idbPut } from './idb'

/**
 * 바이브/캐릭레퍼 웹 구현 — src/main/refs/prepare.ts + repo.ts의 파일 결합 부분 대응.
 * SQL 계열(enabled 행 조회·인코딩 캐시·업데이트류)은 원본 repo를 재사용하고,
 * 파일 읽기/쓰기(fs)와 sharp만 IndexedDB + Canvas로 대체한다.
 * 인코딩 규칙(ie 변경 시에만 재인코딩, 2 Anlas)과 전처리 캔버스 규격은 데스크톱과 동일.
 */

const REFS_PREFIX = 'web://refs/'

export async function prepareVibes(
  token: string
): Promise<{ vibes: VibeOptions[]; newlyEncoded: number[] }> {
  const rows = enabledVibeRows()
  const vibes: VibeOptions[] = []
  const newlyEncoded: number[] = []
  for (const row of rows) {
    let encoded = row.encoded
    if (!encoded || row.encodedIe !== row.infoExtracted) {
      const buf = await readImageBytes(row.filePath)
      if (!buf) throw new Error(`바이브 원본을 찾을 수 없습니다: ${row.filePath}`)
      const res = await fetch(ENDPOINTS.encodeVibe, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: buf.toString('base64'),
          information_extracted: row.infoExtracted,
          model: 'nai-diffusion-4-5-full'
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`바이브 인코딩 실패 ${res.status}: ${text.slice(0, 200)}`)
      }
      encoded = Buffer.from(await res.arrayBuffer()).toString('base64')
      saveVibeEncoding(row.id, encoded, row.infoExtracted)
      newlyEncoded.push(row.id)
    }
    vibes.push({ strength: row.strength, encodedVibeBase64: encoded })
  }
  return { vibes, newlyEncoded }
}

/** 캐릭레퍼 전처리 — OpenAPI 명세 캔버스(1024×1536/1536×1024/1472×1472)에 검정 패딩 (데스크톱 동일) */
async function processCharRefImage(filePath: string): Promise<string> {
  const buf = await readImageBytes(filePath)
  if (!buf) throw new Error(`레퍼런스 원본을 찾을 수 없습니다: ${filePath}`)
  const bmp = await createImageBitmap(new Blob([new Uint8Array(buf).slice()]))
  const ratio = bmp.width / bmp.height
  bmp.close()
  const canvas =
    ratio > 1.2 ? { w: 1536, h: 1024 } : ratio < 1 / 1.2 ? { w: 1024, h: 1536 } : { w: 1472, h: 1472 }
  const png = await resizeContainPng(buf, canvas.w, canvas.h, '#000000')
  return png.toString('base64')
}

export async function prepareCharRefs(): Promise<CharacterReferenceOptions[]> {
  const rows = enabledCharRefRows()
  const result: CharacterReferenceOptions[] = []
  for (const row of rows) {
    result.push({
      referenceType: row.refType as CharacterReferenceOptions['referenceType'],
      strength: row.strength,
      fidelity: row.fidelity,
      imageBase64: await processCharRefImage(row.filePath)
    })
  }
  return result
}

// ── 추가/삭제 (repo의 파일 결합 함수 대응 — 테이블·INSERT 규칙은 원본과 동일) ──

const TABLES = {
  vibe: 'vibe_images',
  charref: 'charref_images'
} as const

/** 파일 bytes(picker는 메인에서) → web://refs/ 저장 + 썸네일(192 cover webp q82) + 행 삽입 */
export async function addRefFiles(
  kind: 'vibe' | 'charref',
  folderId: number | null,
  files: { name: string; mime: string; bytes: Uint8Array }[]
): Promise<number> {
  if (files.length === 0) return 0

  const db = getDb()
  const table = TABLES[kind]
  const max = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table}`).get() as {
    m: number
  }
  let order = max.m

  for (const file of files) {
    const buf = Buffer.from(file.bytes)
    const dot = file.name.lastIndexOf('.')
    const ext = dot > 0 ? file.name.slice(dot) : '.png'
    const name = dot > 0 ? file.name.slice(0, dot) : file.name
    const dest = `${REFS_PREFIX}${randomUUID()}${ext}`
    await idbPut('files', dest, { bytes: new Uint8Array(buf).slice(), mime: file.mime || 'image/png' })
    const thumbnail = await makeCoverThumbnail(buf)
    db.prepare(
      `INSERT INTO ${table} (name, file_path, thumbnail, folder_id, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(name, dest, thumbnail, folderId, ++order)
  }
  return files.length
}

/** 삭제 — 행 + web://refs/ 원본 blob (데스크톱의 refsDir 내부 파일 삭제와 동일 의미) */
export async function deleteRefImageWeb(kind: 'vibe' | 'charref', id: number): Promise<void> {
  const db = getDb()
  const row = db.prepare(`SELECT file_path FROM ${TABLES[kind]} WHERE id = ?`).get(id) as
    | { file_path: string }
    | undefined
  db.prepare(`DELETE FROM ${TABLES[kind]} WHERE id = ?`).run(id)
  if (row && row.file_path.startsWith(REFS_PREFIX)) {
    await deleteFileBytes(row.file_path)
  }
}
