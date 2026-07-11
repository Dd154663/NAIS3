import { getDb } from './index'

/**
 * 웹 설정/토큰 저장 — src/main/db/settings.ts의 웹 대응.
 * OS 키체인(safeStorage)이 없으므로 토큰은 base64로만 저장한다.
 * 이는 데스크톱의 "safeStorage 미지원 환경" 폴백과 동일한 동작이다.
 * (브라우저 저장소는 어차피 오리진 격리 — 한계는 web/README.md에 문서화)
 */

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

const TOKEN_KEY = 'nai_token_encrypted'

export function setNaiToken(token: string): void {
  setSetting(TOKEN_KEY, Buffer.from(token.trim()).toString('base64'))
}

export function getNaiToken(): string | null {
  const stored = getSetting(TOKEN_KEY)
  if (!stored) return null
  try {
    return Buffer.from(stored, 'base64').toString('utf-8')
  } catch {
    return null
  }
}

export function deleteNaiToken(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
}

export function getNaiTokenInfo(): { hasToken: boolean; prefix: string; length: number } {
  const token = getNaiToken()
  if (!token) return { hasToken: false, prefix: '', length: 0 }
  return { hasToken: true, prefix: token.slice(0, 4), length: token.length }
}
