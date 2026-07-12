/**
 * DOM 결합 IO — 파일 picker(다이얼로그 대체)와 다운로드(파일 저장 대체).
 * **메인 스레드 전용.** 워커 번들에 새지 않도록 image-utils에서 분리 (P5).
 */

/** base64/bytes → 다운로드 트리거 (images:saveAs·백업 내보내기) */
export function downloadBytes(
  bytes: Uint8Array | Buffer | Blob,
  filename: string,
  mime = 'application/octet-stream'
): void {
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice()], {
          type: mime
        })
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

/** picker File[] → RPC로 보낼 수 있는 형태 */
export async function filesToPayload(
  files: File[]
): Promise<{ name: string; mime: string; bytes: Uint8Array }[]> {
  return Promise.all(
    files.map(async (f) => ({
      name: f.name,
      mime: f.type || 'application/octet-stream',
      bytes: new Uint8Array(await f.arrayBuffer())
    }))
  )
}
