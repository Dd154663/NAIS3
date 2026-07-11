import type BetterSqlite3 from 'better-sqlite3'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { migrations } from '@main/db/migrations'
import { idbGet, idbPut } from '../idb'

/**
 * 웹 DB 레이어 — better-sqlite3 대신 sql.js(WASM, 동기 API).
 *
 * 핵심 설계: src/main의 repo/마이그레이션 코드를 "무수정" 재사용하기 위해
 * better-sqlite3의 사용 표면(prepare/run/get/all/exec/pragma/transaction)을 흉내낸
 * 어댑터를 제공한다. vite.web.config.ts가 src/main/db/index.ts import를 이 모듈로
 * 리다이렉트하므로, repo 코드의 getDb()는 그대로 이 어댑터를 받는다.
 *
 * 지속성: 인메모리 DB를 IndexedDB(kv: 'nais3.db')에 디바운스 export.
 * 마이그레이션 전 백업(kv: 'backup-pre-vN')은 데스크톱의 파일 백업과 같은 취지.
 */

const DB_KEY = 'nais3.db'
const PERSIST_DEBOUNCE_MS = 400

let raw: SqlJsDatabase | null = null
let adapter: WebDatabase | null = null

let dirty = false
let persistTimer: ReturnType<typeof setTimeout> | undefined

function markDirty(): void {
  dirty = true
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => void persistNow(), PERSIST_DEBOUNCE_MS)
}

export async function persistNow(): Promise<void> {
  if (!dirty || !raw) return
  dirty = false
  await idbPut('kv', DB_KEY, raw.export())
}

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
    private readonly db: SqlJsDatabase,
    private readonly sql: string
  ) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.db.run(this.sql, normalizeParams(params))
    const changes = this.db.getRowsModified()
    const res = this.db.exec('SELECT last_insert_rowid()')
    const lastInsertRowid = Number(res[0]?.values[0]?.[0] ?? 0)
    markDirty()
    return { changes, lastInsertRowid }
  }

  get(...params: unknown[]): unknown {
    const stmt = this.db.prepare(this.sql)
    try {
      stmt.bind(normalizeParams(params))
      if (!stmt.step()) return undefined
      return convertRow(stmt.getAsObject())
    } finally {
      stmt.free()
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.db.prepare(this.sql)
    try {
      stmt.bind(normalizeParams(params))
      const rows: unknown[] = []
      while (stmt.step()) rows.push(convertRow(stmt.getAsObject()))
      return rows
    } finally {
      stmt.free()
    }
  }
}

class WebDatabase {
  constructor(private readonly db: SqlJsDatabase) {}

  prepare(sql: string): WebStatement {
    return new WebStatement(this.db, sql)
  }

  exec(sql: string): this {
    this.db.exec(sql)
    markDirty()
    return this
  }

  pragma(src: string, opts?: { simple?: boolean }): unknown {
    const res = this.db.exec(`PRAGMA ${src}`)
    if (opts?.simple) return res[0]?.values[0]?.[0]
    return res
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.db.exec('BEGIN')
      try {
        const result = fn(...args)
        this.db.exec('COMMIT')
        markDirty()
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
  return 'browser://indexeddb/nais3.db'
}

export function closeDb(): void {
  adapter?.close()
  adapter = null
  raw = null
}

/** 웹 부트스트랩 전용 — sql.js 로드 → 저장본 복원 → 마이그레이션 (데스크톱 initDb와 동일 규칙) */
export async function initWebDb(): Promise<{ version: number; path: string }> {
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl })
  const saved = await idbGet<Uint8Array>('kv', DB_KEY)
  raw = saved ? new SQL.Database(saved) : new SQL.Database()
  adapter = new WebDatabase(raw)

  adapter.exec('PRAGMA foreign_keys = ON')

  const current = Number(adapter.pragma('user_version', { simple: true }) ?? 0)
  const target = migrations.length

  if (current < target) {
    // 마이그레이션 전 스냅샷 백업 (데스크톱의 pre-migration-vN.db와 동일 취지)
    if (current > 0 && saved) await idbPut('kv', `backup-pre-v${current}`, saved)
    for (let v = current; v < target; v++) {
      const migrate = adapter.transaction(() => {
        migrations[v](getDb())
        adapter!.pragma(`user_version = ${v + 1}`)
      })
      migrate()
    }
    await persistNow()
  } else if (current > target) {
    throw new Error(
      `DB version ${current} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }

  // 탭 전환/닫기 시 미저장분 flush (디바운스 창 유실 방지)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void persistNow()
  })
  window.addEventListener('pagehide', () => void persistNow())

  return { version: target, path: getDbPath() }
}
