import { getPresetName } from '@main/scenes/repo'
import { getDb } from './db'
import { deleteFileBytes, readImageBytes } from './images/storage'

/**
 * 씬 파일 계열 웹 구현 — src/main/scenes/repo.ts의 fs/dialog/JSZip 결합 함수 대응.
 * JSON 스키마({version:1, scenes:[...]})·NAIS2 scenePrompt 폴백·ZIP 선정/이름 규칙
 * (즐겨찾기 전부, 없으면 최신 1장; 다수일 때만 _N 접미)은 원본과 동일하게 유지한다.
 * P5부터 워커에서 돎 — picker/다운로드는 메인(main-handlers)이 담당하고 여기는 데이터만 다룬다.
 */

/** 선택 씬들의 생성 이미지 전부 삭제 (행 + blob) — 데스크톱 bulkClearImages 대응 */
export async function bulkClearImagesWeb(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  const db = getDb()
  const q = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT file_path FROM images WHERE scene_id IN (${q})`)
    .all(...ids) as { file_path: string }[]
  db.prepare(`DELETE FROM images WHERE scene_id IN (${q})`).run(...ids)
  for (const r of rows) await deleteFileBytes(r.file_path)
  return rows.length
}

/** 씬의 즐겨찾기 제외 전체 삭제 — 데스크톱 deleteNonFavorites 대응 */
export async function deleteNonFavoritesWeb(sceneId: number): Promise<number> {
  const db = getDb()
  const rows = db
    .prepare('SELECT id, file_path FROM images WHERE scene_id = ? AND favorite = 0')
    .all(sceneId) as { id: number; file_path: string }[]
  db.prepare('DELETE FROM images WHERE scene_id = ? AND favorite = 0').run(sceneId)
  for (const r of rows) await deleteFileBytes(r.file_path)
  return rows.length
}

export function exportScenesJsonData(presetId: number): string {
  const scenes = getDb()
    .prepare(
      'SELECT name, prompt, negative_prompt, width, height FROM gen_scenes WHERE preset_id = ? ORDER BY sort_order, id'
    )
    .all(presetId) as {
    name: string
    prompt: string
    negative_prompt: string
    width: number
    height: number
  }[]
  const data = scenes.map((s) => ({
    name: s.name,
    prompt: s.prompt,
    negativePrompt: s.negative_prompt,
    width: s.width,
    height: s.height
  }))
  return JSON.stringify({ version: 1, scenes: data }, null, 2)
}

export function importScenesJsonText(presetId: number, text: string): number {
  const parsed = JSON.parse(text) as {
    scenes?: {
      name?: string
      prompt?: string
      /** NAIS2 씬 내보내기(JSON) 포맷의 프롬프트 필드명 */
      scenePrompt?: string
      negativePrompt?: string
      width?: number
      height?: number
    }[]
  }
  const scenes = parsed.scenes ?? []
  const db = getDb()
  const max = db
    .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM gen_scenes WHERE preset_id = ?')
    .get(presetId) as { m: number }
  let order = max.m
  const stmt = db.prepare(
    'INSERT INTO gen_scenes (preset_id, name, prompt, negative_prompt, width, height, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  db.transaction(() => {
    for (const s of scenes) {
      stmt.run(
        presetId,
        s.name ?? '씬',
        s.prompt ?? s.scenePrompt ?? '', // NAIS2 파일은 scenePrompt
        s.negativePrompt ?? '',
        s.width ?? 832,
        s.height ?? 1216,
        ++order
      )
    }
  })()
  return scenes.length
}

type ZipEntry = { filePath: string; name: string }

function extOf(p: string): string {
  const base = p.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** 씬별 내보낼 이미지 선정 + 이름 — 데스크톱 zipEntriesForScenes와 동일 규칙 */
function zipEntriesForScenes(sceneIds: number[]): ZipEntry[] {
  const db = getDb()
  const entries: ZipEntry[] = []
  for (const sceneId of sceneIds) {
    const scene = db.prepare('SELECT name FROM gen_scenes WHERE id = ?').get(sceneId) as
      | { name: string }
      | undefined
    if (!scene) continue
    const favorites = db
      .prepare('SELECT file_path FROM images WHERE scene_id = ? AND favorite = 1 ORDER BY id DESC')
      .all(sceneId) as { file_path: string }[]
    const picks =
      favorites.length > 0
        ? favorites
        : (db
            .prepare('SELECT file_path FROM images WHERE scene_id = ? ORDER BY id DESC LIMIT 1')
            .all(sceneId) as { file_path: string }[])
    const safe = scene.name.replace(/[/\\:*?"<>|]/g, '_').trim() || `씬-${sceneId}`
    picks.forEach((p, i) => {
      const suffix = picks.length > 1 ? `_${i + 1}` : ''
      entries.push({ filePath: p.file_path, name: `${safe}${suffix}${extOf(p.file_path) || '.png'}` })
    })
  }
  return entries
}

export interface ZipData {
  count: number
  name: string
  /** count=0이면 null (메인이 다운로드 생략) */
  bytes: Uint8Array | null
}

async function zipFilesData(entries: ZipEntry[], defaultName: string): Promise<ZipData> {
  if (entries.length === 0) return { count: 0, name: defaultName, bytes: null }
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const used = new Set<string>()
  for (const e of entries) {
    const buf = await readImageBytes(e.filePath)
    if (!buf) continue // 원본 만료/없음 — 데스크톱의 "파일 없으면 건너뜀"과 동일
    let name = e.name
    while (used.has(name)) name = `_${name}` // 동명 씬 충돌 폴백
    used.add(name)
    zip.file(name, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice())
  }
  if (used.size === 0) return { count: 0, name: defaultName, bytes: null }
  const blob = await zip.generateAsync({ type: 'blob' })
  return { count: used.size, name: defaultName, bytes: new Uint8Array(await blob.arrayBuffer()) }
}

export async function exportZipData(presetId: number): Promise<ZipData> {
  const sceneIds = (
    getDb()
      .prepare('SELECT id FROM gen_scenes WHERE preset_id = ? ORDER BY sort_order, id')
      .all(presetId) as { id: number }[]
  ).map((r) => r.id)
  const presetName = (getPresetName(presetId) ?? '씬').replace(/[/\\:*?"<>|]/g, '_')
  return zipFilesData(zipEntriesForScenes(sceneIds), `${presetName}_${Date.now()}.zip`)
}

export async function bulkExportZipData(ids: number[]): Promise<ZipData> {
  if (ids.length === 0) return { count: 0, name: '', bytes: null }
  return zipFilesData(zipEntriesForScenes(ids), `scenes_${Date.now()}.zip`)
}
