/**
 * zlib shim — images/metadata.ts가 import하는 이름만 제공.
 * PNG zTXt/스텔스 메타데이터의 압축 해제 경로는 웹 1차 포팅에서 미지원
 * (비압축 tEXt와 DB payload 폴백 경로는 zlib 없이 동작한다).
 */

export function inflateSync(_buf: Uint8Array): never {
  throw new Error('[web] zlib.inflateSync는 웹에서 지원되지 않습니다')
}

export function gunzipSync(_buf: Uint8Array): never {
  throw new Error('[web] zlib.gunzipSync는 웹에서 지원되지 않습니다')
}
