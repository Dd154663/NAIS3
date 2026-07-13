#!/usr/bin/env node
/**
 * 그림자 파일 드리프트 센티널 (유지보수 가드레일 G2).
 *
 * 이름은 web-drift지만 이제 웹 포트(src/web)와 셀프호스트 서버(src/server) 두 포트를 함께 지킨다.
 * 웹 포트에는 Electron 결합 때문에 원작 코드를 재사용하지 못하고 병렬로
 * 구현한 "그림자 파일"들이, 서버 포트에는 원작 모듈을 직접 재사용하거나 이식한 지점들이 있다.
 * 원작 쪽이 바뀌면 두 포트도 검토가 필요하지만, 그 어긋남은
 * 타입체크·빌드로는 잡히지 않는다 (동작 변경이므로). 이 스크립트는 감시 대상 원작 파일의
 * 해시를 drift-sentinel.json과 대조해, 변경이 있으면 어떤 포트 파일(웹/서버)을 검토해야 하는지
 * 알려주고 실패(exit 1)한다. CI(web-check.yml)에서 실행된다.
 *
 *   node src/web/tools/drift-check.mjs            # 검증 (npm run check:web-drift)
 *   node src/web/tools/drift-check.mjs --update   # 검토 완료 후 해시 갱신 (…:update)
 *
 * 의존성 없음 (node 내장만). 해시 전 CRLF→LF 정규화 — Windows 체크아웃과 CI가 같은 해시를 보게.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sentinelPath = join(root, 'src', 'web', 'tools', 'drift-sentinel.json')

const hashOf = (relPath) =>
  createHash('sha256')
    .update(readFileSync(join(root, relPath), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex')

const sentinel = JSON.parse(readFileSync(sentinelPath, 'utf8'))
const drifted = []
for (const [file, entry] of Object.entries(sentinel.watch)) {
  const current = hashOf(file)
  if (current !== entry.hash) drifted.push({ file, entry, current })
}

if (process.argv.includes('--update')) {
  for (const { file, current } of drifted) sentinel.watch[file].hash = current
  writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2) + '\n')
  console.log(
    drifted.length === 0
      ? '[web-drift] 변경 없음 — 갱신할 해시가 없습니다'
      : `[web-drift] 해시 갱신 완료 (${drifted.length}개): ${drifted.map((d) => d.file).join(', ')}`
  )
  process.exit(0)
}

if (drifted.length === 0) {
  console.log(`[web-drift] OK — 감시 대상 ${Object.keys(sentinel.watch).length}개 파일 변경 없음`)
  process.exit(0)
}

console.error(
  '[web-drift] 원작 파일이 변경되었습니다. 포트(웹 src/web · 서버 src/server)의 대응 구현 검토가 필요합니다.\n'
)
for (const { file, entry } of drifted) {
  console.error(`  변경됨: ${file}`)
  for (const m of entry.mirror) console.error(`    → 검토: ${m}`)
}
console.error(
  '\n대응 절차 (src/web/README.md "유지보수 계약" 참조):' +
    '\n  1. 변경 내용이 웹 쪽 대응 구현에도 필요한지 검토 (git diff로 확인)' +
    '\n  2. 필요하면 위 "검토" 파일에 반영, 불필요하면 그대로' +
    '\n  3. npm run check:web-drift:update 로 해시 갱신 후 함께 커밋' +
    '\n웹 포트를 직접 수정하기 어려우면 이 출력과 함께 이슈로 남겨주세요.'
)
process.exit(1)
