import type BetterSqlite3 from 'better-sqlite3'
import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import { migrations } from '@main/db/migrations'
import { idbGet, idbPut } from '../idb'

/**
 * 웹 DB 레이어 — 공식 SQLite WASM(@sqlite.org/sqlite-wasm) + opfs-sahpool VFS.
 *
 * **Worker 전용.** opfs-sahpool(동기 파일 IO)은 Worker에서만 동작한다 — 재사용하는
 * src/main repo들이 동기(better-sqlite3식) API라 이 제약이 워커 백엔드 구조의 근거다.
 * (SharedArrayBuffer 기반 메인스레드 동기화는 GitHub Pages가 COOP/COEP 헤더를 못 줘 배제)
 *
 * better-sqlite3 사용 표면(prepare/run/get/all/exec/pragma/transaction)을 흉내내는
 * WebDatabase 어댑터는 유지 — vite가 src/main/db import를 여기로 리다이렉트하므로
 * repo 코드는 계속 무수정 재사용된다.
 *
 * sql.js 시절과 달리 쓰기가 페이지 단위로 OPFS에 직접 반영된다 (전체 export 없음)
 * — 대용량 히스토리에서의 쓰기 증폭 문제(M3의 발단)가 여기서 해소된다.
 * 기존 IndexedDB 저장본(kv 'nais3.db')은 최초 부팅 시 1회 이식한다.
 */

const DB_FILE = '/nais3.db'
const LEGACY_IDB_KEY = 'nais3.db'
const LEGACY_BACKUP_KEY = 'nais3.db.migrated-backup'

// 패키지 타입이 버전별로 유동적이라 사용 표면만 구조 타입으로 고정
interface SqliteStmt {
  bind(values: unknown[]): SqliteStmt
  step(): boolean
  get(target: Record<string, unknown>): Record<string, unknown>
  finalize(): unknown
}
interface SqliteDb {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStmt
  changes(): number
  selectValue(sql: string): unknown
  close(): void
}

let raw: SqliteDb | null = null
let adapter: WebDatabase | null = null

/** dev 전용 — 마이그레이션 리허설용 저수준 컨트롤 (initWebDb에서 DEV일 때만 채워짐) */
export const __devDbControls: {
  exportDb?: () => Promise<Uint8Array>
  wipeDb?: () => Promise<void>
} = {}

type SqlValue = number | string | Uint8Array | null

function normalizeParams(params: unknown[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    return p as SqlValue
  })
}

/** BLOB 컬럼을 Buffer로 — better-sqlite3와 동일하게 .toString('base64')가 동작해야 한다 */
function convertRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key]
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) row[key] = Buffer.from(v)
  }
  return row
}

class WebStatement {
  constructor(
    private readonly db: SqliteDb,
    private readonly sql: string
  ) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const stmt = this.db.prepare(this.sql)
    try {
      if (params.length) stmt.bind(normalizeParams(params))
      stmt.step()
    } finally {
      stmt.finalize()
    }
    return {
      changes: this.db.changes(),
      lastInsertRowid: Number(this.db.selectValue('SELECT last_insert_rowid()'))
    }
  }

  get(...params: unknown[]): unknown {
    const stmt = this.db.prepare(this.sql)
    try {
      if (params.length) stmt.bind(normalizeParams(params))
      if (!stmt.step()) return undefined
      return convertRow(stmt.get({}))
    } finally {
      stmt.finalize()
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.db.prepare(this.sql)
    try {
      if (params.length) stmt.bind(normalizeParams(params))
      const rows: unknown[] = []
      while (stmt.step()) rows.push(convertRow(stmt.get({})))
      return rows
    } finally {
      stmt.finalize()
    }
  }
}

class WebDatabase {
  constructor(private readonly db: SqliteDb) {}

  prepare(sql: string): WebStatement {
    return new WebStatement(this.db, sql)
  }

  exec(sql: string): this {
    this.db.exec(sql)
    return this
  }

  pragma(src: string, opts?: { simple?: boolean }): unknown {
    if (src.includes('=')) {
      this.db.exec(`PRAGMA ${src}`)
      return undefined
    }
    const value = this.db.selectValue(`PRAGMA ${src}`)
    return opts?.simple ? value : [{ [src]: value }]
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.db.exec('BEGIN')
      try {
        const result = fn(...args)
        this.db.exec('COMMIT')
        return result
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    }
  }

  close(): void {
    this.db.close()
  }
}

/** src/main repo 코드가 기대하는 시그니처 그대로 (리다이렉트 대상) */
export function getDb(): BetterSqlite3.Database {
  if (!adapter) throw new Error('DB not initialized — call initWebDb() first')
  return adapter as unknown as BetterSqlite3.Database
}

export function getDbPath(): string {
  return 'browser://opfs/nais3.db'
}

export function closeDb(): void {
  adapter?.close()
  adapter = null
  raw = null
}

/** 워커 부트스트랩 전용 — VFS 설치 → (필요 시) 구 IndexedDB 저장본 이식 → 마이그레이션 */
export async function initWebDb(): Promise<{ version: number; path: string }> {
  const sqlite3 = await sqlite3InitModule()
  const poolUtil = await sqlite3.installOpfsSAHPoolVfs({})

  // 구버전(sql.js + IndexedDB export) 사용자 데이터 1회 이식.
  // 원본은 즉시 지우지 않고 백업 키로 이름만 바꿔 보존한다 (롤백 여지).
  const existing: string[] = poolUtil.getFileNames()
  if (!existing.includes(DB_FILE)) {
    const legacy = await idbGet<Uint8Array>('kv', LEGACY_IDB_KEY)
    if (legacy && legacy.byteLength > 0) {
      poolUtil.importDb(DB_FILE, legacy)
      await idbPut('kv', LEGACY_BACKUP_KEY, legacy)
      const { idbDelete } = await import('../idb')
      await idbDelete('kv', LEGACY_IDB_KEY)
    }
  }

  raw = new poolUtil.OpfsSAHPoolDb(DB_FILE) as unknown as SqliteDb
  adapter = new WebDatabase(raw)

  adapter.exec('PRAGMA foreign_keys = ON')

  const current = Number(adapter.pragma('user_version', { simple: true }) ?? 0)
  const target = migrations.length

  if (current < target) {
    // 마이그레이션 전 스냅샷 백업 (데스크톱의 pre-migration-vN.db와 동일 취지)
    if (current > 0) {
      try {
        await idbPut('kv', `backup-pre-v${current}`, await poolUtil.exportFile(DB_FILE))
      } catch {
        // 백업 실패가 마이그레이션을 막지는 않는다
      }
    }
    for (let v = current; v < target; v++) {
      const migrate = adapter.transaction(() => {
        migrations[v](getDb())
        adapter!.pragma(`user_version = ${v + 1}`)
      })
      migrate()
    }
  } else if (current > target) {
    throw new Error(
      `DB version ${current} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }

  if (import.meta.env.DEV) {
    __devDbControls.exportDb = async () => (await poolUtil.exportFile(DB_FILE)) as Uint8Array
    __devDbControls.wipeDb = async () => {
      closeDb()
      await poolUtil.wipeFiles()
    }
  }

  return { version: target, path: getDbPath() }
}
