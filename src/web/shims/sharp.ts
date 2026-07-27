/**
 * sharp shim.
 * 웹의 일반 이미지 처리는 src/web/backend/image-utils.ts(Canvas)가 담당하지만,
 * images/metadata.ts의 스텔스 메타데이터 추출이 쓰는 단 하나의 체인
 * `sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })`는
 * 여기서 Canvas getImageData로 에뮬레이션한다 (RGBA 4채널 — getImageData의 알파는
 * 무손실이라 alpha-LSB 추출이 안전하다). 그 외 메서드는 호출 시 명확히 실패한다.
 */

interface RawResult {
  data: Buffer
  info: { width: number; height: number; channels: number }
}

class WebSharpChain {
  private wantRaw = false

  constructor(private readonly input: unknown) {}

  ensureAlpha(): this {
    return this // getImageData는 항상 RGBA
  }

  raw(): this {
    this.wantRaw = true
    return this
  }

  async toBuffer(opts?: { resolveWithObject?: boolean }): Promise<RawResult | Buffer> {
    if (!this.wantRaw) {
      throw new Error('[web] sharp.toBuffer는 raw() 체인만 지원합니다 (스텔스 메타데이터용)')
    }
    const u8 =
      this.input instanceof Uint8Array
        ? new Uint8Array(this.input.buffer, this.input.byteOffset, this.input.byteLength).slice()
        : (() => {
            throw new Error('[web] sharp 입력은 Buffer/Uint8Array만 지원합니다')
          })()
    const bmp = await createImageBitmap(new Blob([u8]))
    try {
      // 메인/워커 겸용 (P5부터 메타데이터 채널은 워커에서 돎)
      let canvas: HTMLCanvasElement | OffscreenCanvas
      if (typeof document === 'undefined') {
        canvas = new OffscreenCanvas(bmp.width, bmp.height)
      } else {
        canvas = document.createElement('canvas')
        canvas.width = bmp.width
        canvas.height = bmp.height
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null
      if (!ctx) throw new Error('2D 컨텍스트 생성 실패')
      ctx.drawImage(bmp, 0, 0)
      const image = ctx.getImageData(0, 0, bmp.width, bmp.height)
      const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
      const result: RawResult = {
        data,
        info: { width: bmp.width, height: bmp.height, channels: 4 }
      }
      return opts?.resolveWithObject ? result : data
    } finally {
      bmp.close()
    }
  }

  private unsupported(name: string): never {
    throw new Error(`[web] sharp.${name}은 웹에서 지원되지 않습니다 — Canvas 기반 image-utils 사용`)
  }

  resize(): never {
    return this.unsupported('resize')
  }
  webp(): never {
    return this.unsupported('webp')
  }
  png(): never {
    return this.unsupported('png')
  }
  greyscale(): never {
    return this.unsupported('greyscale')
  }
  flatten(): never {
    return this.unsupported('flatten')
  }
  metadata(): never {
    return this.unsupported('metadata')
  }
}

export default function sharp(input: unknown): WebSharpChain {
  return new WebSharpChain(input)
}
