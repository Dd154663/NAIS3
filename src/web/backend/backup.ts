import { getDb } from './db'
import { getSetting, setSetting } from './db/settings'
import { idbPut } from './idb'
import { readImageBytes } from './images/storage'

/**
 * NAIS3 백업 웹 구현 — src/main/backup/repo.ts 대응.
 *
 * 원본을 재사용하지 않는 이유(중요): 원본 exportAll은 바이브/캐릭레퍼 원본 파일을
 * readFileSync로 인라인하는데, 웹 fs shim 위에서는 이미지가 조용히 누락되거나
 * (shim이 string을 반환해) 오염된 백업이 만들어질 수 있다 — 조용한 데이터 유실 위험.
 * JSON 포맷(_app/_version/mainParams/tables, __blob/__image 인코딩)과 TABLES 목록은
 * 원본과 동일하게 유지해 데스크톱 ↔ 웹 백업이 서로 호환된다.
 */

const TABLES = [
  'character_folders',
  'character_prompts',
  'fragment_folders',
  'fragments',
  'vibe_folders',
  'vibe_images',
  'charref_folders',
  'charref_images',
  'scene_presets',
  'gen_scenes',
  'prompt_presets'
] as const

const IMAGE_TABLES = new Set(['vibe_images', 'charref_images'])

type Row = Record<string, unknown>

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { __blob: v.toString('base64') }
  return v
}

function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && '__blob' in (v as object)) {
    return Buffer.from((v as { __blob: string }).__blob, 'base64')
  }
  return v
}

export async function exportAllWeb(): Promise<Record<string, unknown>> {
  const db = getDb()
  const tables: Record<string, Row[]> = {}
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Row[]
    const out: Row[] = []
    for (const r of rows) {
      const encoded: Row = {}
      for (const [k, v] of Object.entries(r)) encoded[k] = encodeValue(v)
      if (IMAGE_TABLES.has(t) && typeof r.file_path === 'string') {
        const buf = await readImageBytes(r.file_path)
        encoded.__image = buf ? buf.toString('base64') : null // 원본 없으면 스킵 (데스크톱 동일)
      }
      out.push(encoded)
    }
    tables[t] = out
  }
  return {
    _app: 'NAIS3',
    _version: 1,
    mainParams: getSetting('main_params') || null,
    tables
  }
}

/** 가져오기 — 데스크톱과 동일하게 전체 교체(replace). 이미지 blob은 트랜잭션 전에 기록 */
export async function importAllWeb(data: Record<string, unknown>): Promise<{ imported: number }> {
  const tables = (data.tables ?? {}) as Record<string, Row[]>
  const db = getDb()

  // 1) 이미지 파일 복원을 먼저 (idb는 비동기라 sync 트랜잭션 안에서 불가).
  //    행별 새 경로를 미리 확정해두고, 트랜잭션은 그 경로로 INSERT만 한다.
  const restoredPaths = new Map<Row, string>()
  for (const t of TABLES) {
    if (!IMAGE_TABLES.has(t)) continue
    const rows = tables[t]
    if (!Array.isArray(rows)) continue
    for (const raw of rows) {
      if (typeof raw.__image !== 'string') continue
      const ext = String(raw.file_path ?? '').endsWith('.webp') ? 'webp' : 'png'
      const fp = `web://images/_imported/${t}_${raw.id}_${Date.now()}.${ext}`
      const bytes = Uint8Array.from(atob(raw.__image), (ch) => ch.charCodeAt(0))
      await idbPut('files', fp, { bytes, mime: `image/${ext}` })
      restoredPaths.set(raw, fp)
    }
  }

  // 2) 전체 교체: 역순 비우기 → 순서대로 삽입 (데스크톱 importAll과 동일)
  let imported = 0
  const tx = db.transaction(() => {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run()

    for (const t of TABLES) {
      const rows = tables[t]
      if (!Array.isArray(rows)) continue
      for (const raw of rows) {
        const row: Row = {}
        for (const [k, v] of Object.entries(raw)) {
          if (k === '__image') continue
          row[k] = decodeValue(v)
        }
        const restored = restoredPaths.get(raw)
        if (restored) row.file_path = restored
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`).run(
          ...cols.map((c) => row[c] as never)
        )
        imported++
      }
    }
    if (typeof data.mainParams === 'string') setSetting('main_params', data.mainParams)
  })
  tx()
  return { imported }
}
