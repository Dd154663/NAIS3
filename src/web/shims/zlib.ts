import { inflate, ungzip } from 'pako'

/**
 * zlib shim — pako(순수 JS, 동기 API)로 구현.
 * images/metadata.ts의 zTXt/iTXt 압축 청크(inflateSync)와
 * 스텔스 메타데이터(gunzipSync)가 원본 코드 무수정으로 동작한다.
 */

export function inflateSync(buf: Uint8Array): Buffer {
  return Buffer.from(inflate(buf))
}

export function gunzipSync(buf: Uint8Array): Buffer {
  return Buffer.from(ungzip(buf))
}
