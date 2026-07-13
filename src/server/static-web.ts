/**
 * 정적 프론트 서빙 (P1-②) — 셀프호스트 서버가 웹 빌드(out/web)를 직접 서빙한다.
 * 존재 이유: Tailscale serve(TLS 종단) 뒤에서 사용자가 주소 하나(https://이름.ts.net)만
 * 알면 되게 — 프론트와 WS가 같은 오리진이라 ?server= 파라미터가 사라진다.
 * (GitHub Pages 배포는 "서버 없는 로컬 모드" 전용으로 남는다.)
 *
 * 라우팅 우선순위는 호출부(index.ts)에서 /healthz → /nais-image → 정적 순으로 잡는다.
 * 정적 파일은 액세스 키 없이 서빙한다 — 프론트 코드는 공개물이고, 키는 WS·이미지
 * 데이터만 보호하면 된다(브라우저가 index.html을 받아야 키 프롬프트도 띄울 수 있다).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

/** resources/와 동일 규칙(shims/electron.ts의 APP_ROOT) — 기본 실행 디렉터리 */
const APP_ROOT = process.env.NAIS3_APP_ROOT ?? process.cwd()
/** 정적 웹 루트 — 기본 `<APP_ROOT>/out/web` (npm run build:web 산출물) */
export const WEB_DIST = process.env.NAIS3_WEB_DIST ?? join(APP_ROOT, 'out', 'web')

/** "이 페이지는 NAIS3 서버가 서빙했다" 신호 — 클라이언트가 동일 오리진 자동 서버 모드로 전환 */
const SERVED_FLAG = '<script>window.__NAIS_SERVED__=true</script>'

/** 최소 MIME 표 — vite 산출물이 쓰는 확장자만 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp'
}

const INDEX_PATH = join(WEB_DIST, 'index.html')

/** index.html(및 SPA 폴백) — `</head>` 앞에 서빙 표식 주입 후 no-cache로 응답 */
function serveIndexHtml(res: ServerResponse, head: boolean): void {
  if (!existsSync(INDEX_PATH)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('NAIS3 웹 빌드가 없습니다. `npm run build:web`로 빌드하세요.')
    return
  }
  let html = readFileSync(INDEX_PATH, 'utf-8')
  html = html.includes('</head>')
    ? html.replace('</head>', `${SERVED_FLAG}</head>`)
    : SERVED_FLAG + html
  // index.html은 항상 최신을 받아야 새 배포(해시 에셋)가 반영된다 → no-cache
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(head ? undefined : html)
}

/** 일반 정적 파일 — /assets/는 해시 파일명이라 불변 장기 캐시, sw.js는 no-cache */
function serveFile(res: ServerResponse, filePath: string, ext: string, head: boolean): void {
  const type = MIME[ext] ?? 'application/octet-stream'
  const headers: Record<string, string> = { 'content-type': type }
  if (filePath.startsWith(join(WEB_DIST, 'assets') + sep)) {
    headers['cache-control'] = 'public, max-age=31536000, immutable'
  } else if (filePath === join(WEB_DIST, 'sw.js')) {
    headers['cache-control'] = 'no-cache'
  }
  res.writeHead(200, headers)
  if (head) {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

/**
 * 정적 요청 처리 — 항상 응답을 종결한다(라우팅 최하위).
 * 경로 안전: 원본 req.url의 경로(정규화 전)를 루트에 join·normalize해 루트 밖(..) 접근을 막는다.
 * WHATWG URL은 선행 `..`를 이미 접어버리므로, 탈출 차단은 이 raw 경로 기준으로 해야 성립한다.
 */
export function handleStaticWeb(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('NAIS3 웹 빌드가 없습니다. `npm run build:web`로 빌드한 뒤 재시작하세요.')
    return
  }

  const method = req.method ?? 'GET'
  const head = method === 'HEAD'
  if (method !== 'GET' && !head) {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('method not allowed')
    return
  }

  const rawPath = (req.url ?? '/').split('?')[0]
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }

  const resolved = normalize(join(WEB_DIST, pathname))
  if (resolved !== WEB_DIST && !resolved.startsWith(WEB_DIST + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }

  if (pathname === '/' || pathname === '') {
    serveIndexHtml(res, head)
    return
  }

  const ext = extname(resolved)
  const isFile = existsSync(resolved) && statSync(resolved).isFile()

  // 확장자 없는 경로는 SPA 라우트로 보고 index.html 폴백 (파일이 있으면 그 파일 우선)
  if (!ext && !isFile) {
    serveIndexHtml(res, head)
    return
  }

  if (isFile) {
    if (resolved === INDEX_PATH) serveIndexHtml(res, head)
    else serveFile(res, resolved, ext, head)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
}
