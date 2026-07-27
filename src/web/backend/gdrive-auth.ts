/**
 * Google Drive OAuth — 메인 스레드 전용 (P6, GIS 토큰 모델).
 *
 * 브라우저용 공개 클라이언트 ID로 액세스 토큰을 발급받는다(클라이언트 시크릿 없음).
 * 토큰은 워커(gdrive.ts)로 밀어넣어 Drive REST 호출에 쓴다. GIS 토큰 모델은 리프레시 토큰이
 * 없으므로, 만료 시 `requestDriveToken(false)`로 무팝업 재발급을 시도한다.
 * 스코프는 drive.file만 — 이 앱이 만든 파일에만 접근(비민감, 검증 심사 불요).
 */

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}
interface TokenClient {
  callback: (resp: TokenResponse) => void
  requestAccessToken(overrides?: { prompt?: string }): void
}
interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string
    scope: string
    callback: (resp: TokenResponse) => void
  }): TokenClient
  revoke(token: string, done?: () => void): void
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } }
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const CLIENT_ID = (import.meta.env.VITE_GDRIVE_CLIENT_ID as string | undefined) ?? ''

export interface DriveToken {
  token: string
  expiresAt: number
}

let scriptPromise: Promise<void> | null = null
let tokenClient: TokenClient | null = null
let currentToken: string | null = null

/** 빌드에 클라이언트 ID가 주입됐는지 — 미설정이면 UI에서 Drive 기능 자체를 숨긴다 */
export function isDriveConfigured(): boolean {
  return CLIENT_ID.length > 0
}

function loadGis(): Promise<void> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('GIS 스크립트 로드 실패 (네트워크/차단 확인)'))
    document.head.appendChild(s)
  })
  return scriptPromise
}

async function ensureClient(): Promise<TokenClient> {
  if (tokenClient) return tokenClient
  if (!isDriveConfigured()) throw new Error('VITE_GDRIVE_CLIENT_ID 미설정')
  await loadGis()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('GIS 초기화 실패')
  tokenClient = oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: () => {} // requestDriveToken에서 매 호출마다 교체
  })
  return tokenClient
}

/**
 * 액세스 토큰 요청.
 * @param interactive true면 동의/계정선택 팝업(최초 연결), false면 무팝업 갱신 시도
 */
export async function requestDriveToken(interactive: boolean): Promise<DriveToken> {
  const client = await ensureClient()
  return new Promise<DriveToken>((resolve, reject) => {
    client.callback = (resp: TokenResponse) => {
      if (resp.error || !resp.access_token) {
        reject(new Error(resp.error_description ?? resp.error ?? 'Drive 토큰 발급 실패'))
        return
      }
      currentToken = resp.access_token
      resolve({
        token: resp.access_token,
        expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000
      })
    }
    try {
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** 토큰 폐기 (연결 해제) */
export function revokeDriveToken(): void {
  const oauth2 = window.google?.accounts?.oauth2
  if (currentToken && oauth2) oauth2.revoke(currentToken)
  currentToken = null
}
