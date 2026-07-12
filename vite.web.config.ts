import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 웹(모바일/PWA) 빌드 설정 — Electron 없이 렌더러 + 웹 백엔드(src/web)를 하나의
 * 정적 웹앱으로 빌드한다. 데스크톱 빌드(electron.vite.config.ts)와 완전히 독립.
 *
 * 원칙: 원작 코드는 수정하지 않고 재사용한다.
 * - 순수 모듈(nai/payload·stream·client, fragments/processor, queue 등)은 그대로 import
 * - Node 내장(fs/path/crypto/events)과 electron/sharp는 src/web/shims/* 로 대체
 * - src/main/db(better-sqlite3)는 src/web/backend/db(sql.js)로 리다이렉트
 */

const r = (p: string): string => resolve(__dirname, p)

/** src/main/db → 웹 DB(sql.js) 리다이렉트. import 구문이 아닌 "해석된 파일 경로" 기준. */
function redirectMainDb(): Plugin {
  const webDb = r('src/web/backend/db/index.ts')
  return {
    name: 'nais-web:redirect-main-db',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) return null
      const id = resolved.id.replace(/\\/g, '/')
      if (id.endsWith('/src/main/db/index.ts')) return webDb
      return resolved
    }
  }
}

/**
 * Tailwind v4는 클래스 자동 탐지 기준이 Vite root다. 웹 빌드의 root는 src/web이라
 * 렌더러(src/renderer)가 스캔되지 않아 유틸리티가 통째로 빠진다 — 데스크톱 빌드는
 * electron-vite가 root를 src/renderer로 잡아 문제없던 부분. 원작 main.css를 수정하는
 * 대신 여기서 @source 지시자를 주입한다 (경로는 CSS 파일 위치 기준 = src/renderer/src).
 */
function injectTailwindSource(): Plugin {
  return {
    name: 'nais-web:tailwind-source',
    enforce: 'pre',
    transform(code, id) {
      if (id.replace(/\\/g, '/').endsWith('/src/renderer/src/assets/main.css')) {
        return code.replace(/@import ['"]tailwindcss['"];?/, (m) => `${m}\n@source "..";`)
      }
      return null
    }
  }
}

/** resources/의 대용량 JSON(태그·토크나이저)을 dev 서버와 빌드 산출물에서 서빙 */
function serveResources(): Plugin {
  const FILES = ['t5_tokenizer.json', 'tags.json']
  return {
    name: 'nais-web:serve-resources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = FILES.find((f) => req.url === `/${f}`)
        if (!name) return next()
        res.setHeader('content-type', 'application/json')
        res.end(readFileSync(r(`resources/${name}`)))
      })
    },
    generateBundle() {
      for (const name of FILES) {
        this.emitFile({ type: 'asset', fileName: name, source: readFileSync(r(`resources/${name}`)) })
      }
    }
  }
}

/**
 * 빌드 후 sw.js의 `self.__PRECACHE__ = null`을 실제 에셋 목록으로 치환 — 오프라인 콜드 스타트용.
 * tags.json(16MB)은 제외(지연 로드 유지). 캐시 버전 키는 에셋 목록의 해시 — 파일명이
 * 콘텐츠 해시라 내용이 바뀌면 목록도 바뀐다. dev 서버에선 치환이 없어 프리캐시가 꺼진다.
 */
function swPrecache(): Plugin {
  let assets: string[] = []
  return {
    name: 'nais-web:sw-precache',
    apply: 'build',
    generateBundle(_, bundle) {
      assets = Object.keys(bundle).filter(
        (f) => !f.endsWith('.map') && f !== 'tags.json' && f !== 'index.html'
      )
    },
    closeBundle() {
      const base = process.env.WEB_BASE ?? '/'
      const list = [
        base,
        `${base}index.html`,
        `${base}icon.png`,
        `${base}manifest.webmanifest`,
        ...assets.map((f) => base + f)
      ]
      let hash = 5381
      for (const ch of JSON.stringify(list)) hash = ((hash * 33) ^ ch.charCodeAt(0)) >>> 0
      const version = `nais3-shell-${hash.toString(36)}`
      const swPath = r('out/web/sw.js')
      const code = readFileSync(swPath, 'utf-8')
      writeFileSync(
        swPath,
        code.replace(
          'self.__PRECACHE__ = null',
          `self.__PRECACHE__ = ${JSON.stringify({ version, assets: list })}`
        )
      )
    }
  }
}

export default defineConfig({
  root: r('src/web'),
  // root가 src/web이라 기본 envDir도 거기가 된다 — .env.local은 프로젝트 루트에 두므로
  // envDir를 루트로 되돌린다 (VITE_GDRIVE_CLIENT_ID 등, P6). CI는 process env로 주입.
  envDir: r('.'),
  // GitHub Pages 등 하위 경로 배포용 (예: /NAIS3/). 미지정 시 루트 — dev와 로컬 preview는 '/'
  base: process.env.WEB_BASE ?? '/',
  publicDir: r('src/web/public'),
  plugins: [
    redirectMainDb(),
    injectTailwindSource(),
    serveResources(),
    swPrecache(),
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: {
      '@renderer': r('src/renderer/src'),
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      // Node 내장/네이티브 모듈 → 웹 shim (재사용하는 src/main 모듈들이 import)
      fs: r('src/web/shims/fs.ts'),
      path: r('src/web/shims/path.ts'),
      crypto: r('src/web/shims/crypto.ts'),
      events: r('src/web/shims/events.ts'),
      zlib: r('src/web/shims/zlib.ts'),
      electron: r('src/web/shims/electron.ts'),
      sharp: r('src/web/shims/sharp.ts')
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(
      (JSON.parse(readFileSync(r('package.json'), 'utf-8')) as { version: string }).version
    )
  },
  optimizeDeps: {
    // sqlite-wasm은 자체 워커/wasm 로딩을 하므로 사전 번들에서 제외 (공식 권장)
    exclude: ['@sqlite.org/sqlite-wasm']
  },
  worker: {
    format: 'es', // 워커 안에서 dynamic import(jszip 등) 사용
    // 주의: 워커는 별도 롤업 빌드라 config.plugins가 적용되지 않는다 —
    // src/main/db 리다이렉트가 빠지면 진짜 better-sqlite3가 번들돼 부팅이 죽는다 (P5에서 실제 발생)
    plugins: () => [redirectMainDb()]
  },
  server: {
    host: true // 같은 네트워크의 실기기(폰) 테스트용
  },
  build: {
    outDir: r('out/web'),
    emptyOutDir: true,
    target: 'es2022'
  }
})
