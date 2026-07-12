/// <reference types="vite/client" />

/** vite define — package.json version (vite.web.config.ts) */
declare const __APP_VERSION__: string

/** 빌드 시 주입되는 웹 전용 환경 변수 (로컬 .env.local / GH 저장소 변수) */
interface ImportMetaEnv {
  /** Google Drive OAuth 클라이언트 ID (P6). 미설정이면 Drive 기능 숨김 */
  readonly VITE_GDRIVE_CLIENT_ID?: string
}
