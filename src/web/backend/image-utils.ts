/**
 * Canvas 기반 이미지 유틸 — 데스크톱의 sharp 사용처(썸네일·리사이즈·마스크 정규화·크기 조회)를
 * 브라우저 표준 API로 대체한다.
 */

function toBlobInput(bytes: Uint8Array | Buffer): Blob {
  // Buffer의 backing ArrayBuffer는 오프셋이 있을 수 있어 슬라이스로 정확한 범위만
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return new Blob([u8.slice()])
}

async function decode(bytes: Uint8Array | Buffer): Promise<ImageBitmap> {
  return createImageBitmap(toBlobInput(bytes))
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 실패'))),
      type,
      quality
    )
  })
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D 컨텍스트 생성 실패')
  return [canvas, ctx]
}

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer())
}

export async function imageSize(bytes: Uint8Array | Buffer): Promise<{ width: number; height: number }> {
  const bmp = await decode(bytes)
  const size = { width: bmp.width, height: bmp.height }
  bmp.close()
  return size
}

/**
 * 썸네일 — 데스크톱과 동일 규칙(640×640 fit:inside, webp q90).
 * webp 인코딩 미지원 브라우저(iOS Safari 구버전)는 toBlob이 png로 폴백하는데,
 * <img>는 데이터 매직바이트로 스니핑하므로 표시엔 문제없다.
 */
export async function makeThumbnail(bytes: Uint8Array | Buffer): Promise<Buffer> {
  const bmp = await decode(bytes)
  try {
    const scale = Math.min(1, 640 / Math.max(bmp.width, bmp.height))
    const w = Math.max(1, Math.round(bmp.width * scale))
    const h = Math.max(1, Math.round(bmp.height * scale))
    const [canvas, ctx] = makeCanvas(w, h)
    ctx.drawImage(bmp, 0, 0, w, h)
    return await blobToBuffer(await toBlob(canvas, 'image/webp', 0.9))
  } finally {
    bmp.close()
  }
}

/** i2i 소스 리사이즈 — sharp resize(fit:fill) + png 대응 */
export async function resizeFillPng(
  bytes: Uint8Array | Buffer,
  width: number,
  height: number
): Promise<Buffer> {
  const bmp = await decode(bytes)
  try {
    const [canvas, ctx] = makeCanvas(width, height)
    ctx.drawImage(bmp, 0, 0, width, height)
    return await blobToBuffer(await toBlob(canvas, 'image/png'))
  } finally {
    bmp.close()
  }
}

function stripDataUrl(base64: string): string {
  return base64.replace(/^data:[^,]+,/, '')
}

/**
 * NAI 인페인트 마스크 정규화 — src/main/index.ts normalizeInpaintMask의 Canvas 이식.
 * 검은 배경에 합성 → 1/8 축소(평균) → 밝기 25 초과를 흰색으로 이진화 → 8배 nearest 확대.
 */
export async function normalizeInpaintMask(
  maskBase64: string,
  width: number,
  height: number
): Promise<string> {
  const mw = Math.max(1, Math.round(width / 8))
  const mh = Math.max(1, Math.round(height / 8))

  const bmp = await decode(Buffer.from(stripDataUrl(maskBase64), 'base64'))
  let small: ImageData
  try {
    const [, ctx] = makeCanvas(mw, mh)
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, mw, mh) // flatten: 투명 → 검정
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, mw, mh) // 평균 다운스케일 근사
    small = ctx.getImageData(0, 0, mw, mh)
  } finally {
    bmp.close()
  }

  // 1/8 해상도에서 이진화한 뒤 nearest로 8배 확대 → 8×8 잠재 블록 정렬 (데스크톱과 동일 취지)
  const [smallCanvas, smallCtx] = makeCanvas(mw, mh)
  const bin = smallCtx.createImageData(mw, mh)
  for (let i = 0; i < mw * mh; i++) {
    const r = small.data[i * 4]
    const g = small.data[i * 4 + 1]
    const b = small.data[i * 4 + 2]
    // 데스크톱은 greyscale 후 >25 판정 — luma 근사로 동일 처리
    const v = 0.299 * r + 0.587 * g + 0.114 * b > 25 ? 255 : 0
    bin.data[i * 4] = v
    bin.data[i * 4 + 1] = v
    bin.data[i * 4 + 2] = v
    bin.data[i * 4 + 3] = 255
  }
  smallCtx.putImageData(bin, 0, 0)

  const [outCanvas, outCtx] = makeCanvas(width, height)
  outCtx.imageSmoothingEnabled = false // nearest 확대
  outCtx.drawImage(smallCanvas, 0, 0, width, height)
  const png = await blobToBuffer(await toBlob(outCanvas, 'image/png'))
  return png.toString('base64')
}

/** base64/bytes → 다운로드 트리거 (images:saveAs·백업 내보내기) */
export function downloadBytes(bytes: Uint8Array | Buffer | Blob, filename: string, mime = 'application/octet-stream'): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([toBlobInput(bytes)], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** 파일 선택 (다이얼로그 대체). accept 예: 'image/*', '.json' */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    // 취소 감지 (모던 브라우저는 cancel 이벤트 지원)
    input.oncancel = () => {
      resolve([])
      input.remove()
    }
    input.click()
  })
}
