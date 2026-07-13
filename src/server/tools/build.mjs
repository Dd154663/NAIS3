/**
 * 서버 번들 빌드 — esbuild.
 * 핵심: alias로 electron을 src/server/shims/electron.ts로 바꿔치기해
 * 원본 src/main 모듈을 무수정 재사용한다 (웹 포트의 vite alias와 같은 원칙).
 * 네이티브 모듈(better-sqlite3, sharp)만 external — node_modules에서 로드된다.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))

await build({
  entryPoints: [resolve(root, 'src/server/index.ts')],
  outfile: resolve(root, 'dist-server/nais3-server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  alias: {
    electron: resolve(root, 'src/server/shims/electron.ts'),
    'electron-updater': resolve(root, 'src/server/shims/electron-updater.ts')
  },
  external: ['better-sqlite3', 'sharp', 'bufferutil', 'utf-8-validate'],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  logLevel: 'info'
})
