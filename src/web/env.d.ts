/// <reference types="vite/client" />

/** vite define — package.json version (vite.web.config.ts) */
declare const __APP_VERSION__: string

/**
 * 서버가 서빙한 페이지 표식 — src/server/static-web.ts가 index.html의 `</head>` 앞에 주입한다.
 * true면 동일 오리진 자동 서버 모드로 부팅한다 (server-mode.ts).
 */
interface Window {
  __NAIS_SERVED__?: boolean
}

/** 빌드 시 주입되는 웹 전용 환경 변수 (로컬 .env.local / GH 저장소 변수) */
interface ImportMetaEnv {
  /** Google Drive OAuth 클라이언트 ID (P6). 미설정이면 Drive 기능 숨김 */
  readonly VITE_GDRIVE_CLIENT_ID?: string
}
