import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { app } from 'electron'
import JSZip from 'jszip'
import sharp from 'sharp'
import { getDb } from '../main/db'
import { createFragment } from '../main/fragments/repo'
import { importBase64 } from '../main/library/repo'
import { exportAll, importAll } from '../main/backup/repo'
import { importNais2 } from '../main/backup/nais2'
import { getMemoryImage, isMemoryPath, isUnderImagesRoot } from '../main/images/storage'
import { register } from './registry'

/**
 * 웹 내부 채널(`_` 접두) 서버 이식 — src/web/worker/handlers.ts의 handleRaw 등록부 대응.
 * 브라우저 워커에만 있던 데이터 위임 채널을 서버에도 등록해, 서버 모드에서도 파일/텍스트가
 * 오가는 지점이 끊기지 않게 한다. 계약(req/res)은 워커와 동일하게 유지하고,
 * 브라우저 백엔드(OPFS/Canvas/IDB)가 하던 일만 원본 src/main 모듈(sharp·fs·DB)로 대체한다.
 */

/** 워커 refsDir 대응 — 원본 refs/repo.ts와 동일 경로(userData/refs). private라 동일하게 재구성 */
function refsDir(): string {
  const dir = join(app.getPath('userData'), 'refs')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Buffer → 소유권 있는 Uint8Array (msgpack이 그대로 나른다) */
function toBytes(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice()
}

export function registerWebChannels(): void {
  // ── 캐릭터 썸네일 — picker는 클라이언트, 받은 bytes로 썸네일 생성 + BLOB 저장 ──
  // 규격은 워커(makeThumbnail: 640 inside webp q90)와 동일 — 데스크톱 pickCharacterThumbnail(192)과는 다르다
  register('_chars:setThumbnail', async (_e, req) => {
    const { id, bytes } = req as { id: number; bytes: Uint8Array }
    const thumbnail = await sharp(Buffer.from(bytes))
      .resize(640, 640, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer()
    getDb()
      .prepare(
        "UPDATE character_prompts SET thumbnail = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(thumbnail, id)
    return { thumbnail: thumbnail.toString('base64') }
  })

  // ── 바이브/캐릭레퍼 파일 추가 — 원본 addRefImages의 파일 결합 로직 이식(픽커만 bytes로 대체) ──
  register('_refs:addFiles', async (_e, req) => {
    const { kind, folderId, files } = req as {
      kind: 'vibe' | 'charref'
      folderId: number | null
      files: { name: string; mime: string; bytes: Uint8Array }[]
    }
    if (files.length === 0) return { count: 0 }
    const table = kind === 'vibe' ? 'vibe_images' : 'charref_images'
    const db = getDb()
    const max = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table}`).get() as {
      m: number
    }
    let order = max.m
    for (const file of files) {
      const buf = Buffer.from(file.bytes)
      const dot = file.name.lastIndexOf('.')
      const ext = dot > 0 ? file.name.slice(dot) : '.png'
      const name = dot > 0 ? file.name.slice(0, dot) : file.name
      const dest = join(refsDir(), `${randomUUID()}${ext}`)
      writeFileSync(dest, buf)
      const thumbnail = await sharp(buf)
        .resize(192, 192, { fit: 'cover' })
        .webp({ quality: 82 })
        .toBuffer()
      db.prepare(
        `INSERT INTO ${table} (name, file_path, thumbnail, folder_id, sort_order, enabled)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(name, dest, thumbnail, folderId, ++order)
    }
    return { count: files.length }
  })

  // ── 라이브러리 파일 추가 — 원본 importBase64 재사용 (bytes → base64 위임) ──
  register('_library:importFiles', async (_e, req) => {
    const { files, stackId } = req as {
      files: { name: string; bytes: Uint8Array }[]
      stackId: number | null
    }
    const images = files.map((f) => ({
      name: f.name,
      base64: Buffer.from(f.bytes).toString('base64')
    }))
    return { count: await importBase64(images, stackId) }
  })

  // ── 라이브러리 일괄 내보내기 — 클라이언트가 폴더 대신 ZIP을 받는다(웹 워커와 동일 계약).
  //    연번/배치 순서 규칙은 원본 exportImages와 동일하되 복사 대상이 ZIP 엔트리다 ──
  register('_library:exportZipData', async (_e, req) => {
    const { ids } = req as { ids: number[] }
    const name = `library_${Date.now()}.zip`
    if (ids.length === 0) return { count: 0, name, bytes: null }
    const q = ids.map(() => '?').join(',')
    const rows = getDb()
      .prepare(
        `SELECT file_path FROM library_images WHERE id IN (${q}) ORDER BY sort_order DESC, id DESC`
      )
      .all(...ids) as { file_path: string }[]

    const pad = Math.max(3, String(rows.length).length)
    const zip = new JSZip()
    let count = 0
    for (const r of rows) {
      if (!existsSync(r.file_path)) continue // 원본 없음 — 데스크톱과 동일하게 건너뜀
      const ext = extname(r.file_path) || '.png'
      zip.file(`${String(count + 1).padStart(pad, '0')}${ext}`, readFileSync(r.file_path))
      count++
    }
    if (count === 0) return { count: 0, name, bytes: null }
    return { count, name, bytes: toBytes(await zip.generateAsync({ type: 'nodebuffer' })) }
  })

  // ── 조각 txt 가져오기 — 원본 createFragment 재사용 ──
  register('_frags:importTxts', (_e, req) => {
    const { files } = req as { files: { name: string; text: string }[] }
    for (const f of files) createFragment(f.name.replace(/\.txt$/i, ''), null, f.text)
    return { count: files.length }
  })

  // ── 조각 내보내기 데이터 — 다운로드는 클라이언트, 여기는 행만 ──
  register('_frags:exportData', (_e, req) => {
    const { id } = req as { id: number }
    const row = getDb().prepare('SELECT name, content FROM fragments WHERE id = ?').get(id) as
      { name: string; content: string } | undefined
    return row ?? null
  })

  // ── 씬 JSON 내보내기/가져오기 — 순수 SQL (워커 backend/scenes.ts와 동일 스키마) ──
  register('_scenes:exportJsonData', (_e, req) => {
    const { presetId } = req as { presetId: number }
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
  })

  register('_scenes:importJsonText', (_e, req) => {
    const { presetId, text } = req as { presetId: number; text: string }
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
    return { count: scenes.length }
  })

  // ── 백업 내보내기/가져오기 — 원본 backup/repo.ts 재사용 (서버는 실 fs라 웹과 달리 원본 그대로 안전).
  //    JSON 스키마가 데스크톱과 동일하므로 로컬 모드 백업과 상호 호환된다 ──
  register('_backup:exportJson', () => JSON.stringify(exportAll()))

  register('_backup:importJson', (_e, req) => {
    const { text } = req as { text: string }
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      if (data._app === 'NAIS3') {
        const { imported } = importAll(data)
        return { summary: `NAIS3 백업 복원 완료 (${imported}개 항목)`, needsPromptReload: true }
      }
      if (Object.keys(data).some((k) => k.startsWith('nais2-'))) {
        const r = importNais2(data)
        const parts = [
          r.characters ? `캐릭터 ${r.characters}` : '',
          r.presets ? `프리셋 ${r.presets}` : '',
          r.fragments ? `조각 ${r.fragments}` : '',
          r.scenes ? `씬 ${r.scenes}` : '',
          r.prompt ? '프롬프트' : ''
        ].filter(Boolean)
        return {
          summary: parts.length
            ? `NAIS2에서 ${parts.join(' · ')} 가져옴`
            : '가져올 항목이 없습니다',
          needsPromptReload: r.prompt
        }
      }
      return { error: '알 수 없는 백업 형식입니다' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 이미지 원본 바이트 — saveAs/copy 데이터 소스. nais-image 서빙과 동일한 안전 규칙 ──
  register('_images:readBytes', (_e, req) => {
    const { filePath } = req as { filePath: string }
    if (isMemoryPath(filePath)) {
      const buf = getMemoryImage(filePath)
      return buf ? toBytes(buf) : null
    }
    if (!isUnderImagesRoot(filePath) || !existsSync(filePath)) return null
    return toBytes(readFileSync(filePath))
  })
}
