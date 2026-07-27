import type { ImageMetadata } from '@shared/types'

/**
 * PNG tEXt 청크 주입 — src/main/images/storage.ts의 injectNais3Params와 동일 구현.
 * (원본은 모듈 비공개 + electron 결합 모듈이라 재사용 불가. 순수 Buffer 코드만 이식)
 * 저장 파일을 데스크톱에서 열어도 3분할(promptParts) 메타데이터가 왕복되게 한다.
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NAIS3_KEYWORD = 'nais3-params'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function textChunk(keyword: string, value: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'ascii')
  const out = Buffer.alloc(4 + 4 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  type.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return out
}

export function injectNais3Params(png: Buffer, meta: Pick<ImageMetadata, 'promptParts'>): Buffer {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIG)) return png
  const value = Buffer.from(JSON.stringify({ version: 1, ...meta }), 'utf8').toString('base64')
  const chunk = textChunk(NAIS3_KEYWORD, value)
  const ihdrEnd = 33
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)])
}
