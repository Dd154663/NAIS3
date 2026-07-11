/**
 * sharp shim — import는 성공하되 호출하면 실패.
 * 웹에서 이미지 처리는 src/web/backend/image-utils.ts(Canvas)가 담당한다.
 * 재사용 모듈 중 sharp를 top-level import하는 것들(characters/refs/library repo,
 * images/metadata)이 있어 모듈 로드만 통과시키는 용도.
 */

export default function sharp(..._args: unknown[]): never {
  throw new Error('[web] sharp는 웹에서 지원되지 않습니다 — Canvas 기반 image-utils를 사용하세요')
}
