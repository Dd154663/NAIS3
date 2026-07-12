import { randomUUID } from '../shims/crypto'
import { getDb } from './db'
import { idbPut } from './idb'
import { imageSize, makeThumbnail, pickFiles } from './image-utils'
import { deleteFileBytes, readImageBytes } from './images/storage'

/**
 * 라이브러리 웹 구현 — src/main/library/repo.ts의 파일 결합 부분 대응.
 * 순수 SQL 함수(reorder/stack류)는 원본 repo를 재사용하고(ipc.ts에서 직접 등록),
 * 여기는 가져오기/삭제만: 원본은 항상 curated/ 복사본 → 웹은 web://library/ blob 복사본.
 * 썸네일 규격(640 inside webp q90)과 INSERT 규칙은 원본 insertImage와 동일.
 */

const LIBRARY_PREFIX = 'web://library/'

function splitName(fileName: string): { name: string; ext: string } {
  const dot = fileName.lastIndexOf('.')
  return dot > 0
    ? { name: fileName.slice(0, dot), ext: fileName.slice(dot) }
    : { name: fileName, ext: '' }
}

async function insertImageWeb(
  buf: Buffer,
  name: string,
  ext: string,
  stackId: number | null
): Promise<void> {
  const dest = `${LIBRARY_PREFIX}${randomUUID()}${ext || '.png'}`
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice()
  await idbPut('files', dest, { bytes: u8, mime: ext === '.webp' ? 'image/webp' : 'image/png' })
  const { width, height } = await imageSize(buf)
  const thumbnail = await makeThumbnail(buf)
  getDb()
    .prepare(
      `INSERT INTO library_images (name, file_path, thumbnail, width, height, stack_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM library_images))`
    )
    .run(name, dest, thumbnail, width, height, stackId)
}

/** 파일 picker(다중)로 가져오기 — 데스크톱 importViaDialog 대응 */
export async function importViaPickerWeb(stackId: number | null): Promise<number> {
  const files = await pickFiles('image/png,image/jpeg,image/webp', true)
  for (const file of files) {
    const { name, ext } = splitName(file.name)
    await insertImageWeb(Buffer.from(await file.arrayBuffer()), name, ext, stackId)
  }
  return files.length
}

/** 웹 내부 경로(히스토리 드래그 등)로 가져오기 — 항상 복사 (데스크톱 importPaths 대응) */
export async function importPathsWeb(filePaths: string[], stackId: number | null): Promise<number> {
  let count = 0
  for (const src of filePaths) {
    const buf = await readImageBytes(src)
    if (!buf) continue
    const base = src.split('/').pop() ?? 'image.png'
    const { name, ext } = splitName(base)
    await insertImageWeb(buf, name, ext, stackId)
    count++
  }
  return count
}

/** 외부 드롭(base64)으로 가져오기 — 데스크톱 importBase64 대응 */
export async function importBase64Web(
  images: { name: string; base64: string }[],
  stackId: number | null
): Promise<number> {
  for (const img of images) {
    const buf = Buffer.from(img.base64.replace(/^data:[^,]+,/, ''), 'base64')
    const { name, ext } = splitName(img.name)
    await insertImageWeb(buf, name, ext, stackId)
  }
  return images.length
}

/** 삭제 — 행 + 복사본 blob (라이브러리 파일은 항상 우리가 만든 복사본) */
export async function deleteImagesWeb(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const db = getDb()
  const q = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT file_path FROM library_images WHERE id IN (${q})`)
    .all(...ids) as { file_path: string }[]
  db.prepare(`DELETE FROM library_images WHERE id IN (${q})`).run(...ids)
  for (const r of rows) {
    if (r.file_path.startsWith(LIBRARY_PREFIX)) await deleteFileBytes(r.file_path)
  }
}
