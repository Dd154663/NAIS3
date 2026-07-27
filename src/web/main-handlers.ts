import type { IpcInvokeMap } from '@shared/types'
import { handleRaw } from './bus'
import { rpcInvoke } from './backend/ipc'
import { downloadBytes, filesToPayload, pickFiles } from './backend/dom-io'

/**
 * 메인 스레드 채널 핸들러 (P5) — DOM이 필요한 채널만 여기 남는다:
 * 창/알림 no-op류, 파일 picker 진입 채널(데이터 처리는 워커 `_` 채널로 위임),
 * 다운로드/클립보드 채널(데이터는 워커에서 받아옴).
 * 채널 의미론은 M2와 동일 — 위치만 옮긴 것.
 */

function handle<C extends keyof IpcInvokeMap>(
  channel: C,
  handler: (req: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']
): void {
  handleRaw(channel, handler as (req: unknown) => unknown)
}

export function registerMainHandlers(): void {
  // ── 데스크톱 전용 — 웹에선 no-op / 대응 동작 ─────────────
  handle('window:control', () => {})
  handle('window:setBackground', ({ color }) => {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      document
        .querySelector<HTMLMetaElement>('meta[name=theme-color]')
        ?.setAttribute('content', color)
      document.documentElement.style.backgroundColor = color
    }
  })
  // 웹의 "업데이트 설치 후 재시작" = 새 SW/에셋으로 reload (bootstrap의 updatefound 감지와 짝)
  handle('update:start', () => {
    window.location.reload()
  })
  handle('images:showInFolder', () => {})
  handle('scenes:openFolder', () => ({ ok: false }))

  handle('notify:done', ({ done, failed }) => {
    if (!document.hidden) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const body = failed > 0 ? `${done}장 완료 · ${failed}장 실패` : `${done}장 완료`
    new Notification('NAIS3 생성 완료', { body, silent: true })
  })

  // ── picker 진입 채널 (데이터 처리·DB는 워커) ──────────────
  handle('chars:pickThumbnail', async ({ id }) => {
    const [file] = await pickFiles('image/*', false)
    if (!file) return { thumbnail: null }
    return rpcInvoke<{ thumbnail: string }>('_chars:setThumbnail', {
      id,
      bytes: new Uint8Array(await file.arrayBuffer())
    })
  })

  const addRefs = async (
    kind: 'vibe' | 'charref',
    folderId: number | null
  ): Promise<{ count: number }> => {
    const files = await pickFiles('image/png,image/jpeg,image/webp', true)
    if (files.length === 0) return { count: 0 }
    return rpcInvoke('_refs:addFiles', { kind, folderId, files: await filesToPayload(files) })
  }
  handle('vibes:add', ({ folderId }) => addRefs('vibe', folderId))
  handle('crefs:add', ({ folderId }) => addRefs('charref', folderId))

  handle('library:import', async ({ stackId }) => {
    const files = await pickFiles('image/png,image/jpeg,image/webp', true)
    if (files.length === 0) return { count: 0 }
    return rpcInvoke('_library:importFiles', {
      files: await filesToPayload(files),
      stackId: stackId ?? null
    })
  })

  handle('frags:importTxt', async () => {
    const files = await pickFiles('.txt,text/plain', true)
    if (files.length === 0) return { count: 0 }
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })))
    return rpcInvoke('_frags:importTxts', { files: payload })
  })

  handle('scenes:importJson', async ({ presetId }) => {
    const [file] = await pickFiles('.json,application/json', false)
    if (!file) return { count: 0 }
    return rpcInvoke('_scenes:importJsonText', { presetId, text: await file.text() })
  })

  handle('backup:import', async () => {
    const [file] = await pickFiles('.json,application/json', false)
    if (!file) return { canceled: true as const }
    return rpcInvoke('_backup:importJson', { text: await file.text() })
  })

  // ── 다운로드/클립보드 채널 (데이터는 워커에서) ─────────────
  handle('backup:export', async () => {
    const json = await rpcInvoke<string>('_backup:exportJson')
    const stamp = new Date().toISOString().slice(0, 10)
    downloadBytes(new Blob([json], { type: 'application/json' }), `NAIS3-backup-${stamp}.json`)
    return { saved: true }
  })

  handle('frags:exportTxt', async ({ id }) => {
    const row = await rpcInvoke<{ name: string; content: string } | null>('_frags:exportData', { id })
    if (!row) return { saved: false }
    downloadBytes(new Blob([row.content], { type: 'text/plain' }), `${row.name}.txt`)
    return { saved: true }
  })

  handle('frags:exportAll', async () => {
    const { count, bytes } = await rpcInvoke<{ count: number; bytes: Uint8Array | null }>(
      '_frags:exportAllZip'
    )
    if (bytes) downloadBytes(bytes, 'NAIS3-fragments.zip', 'application/zip')
    return { count }
  })

  handle('scenes:exportJson', async ({ presetId }) => {
    const json = await rpcInvoke<string>('_scenes:exportJsonData', { presetId })
    downloadBytes(new Blob([json], { type: 'application/json' }), 'nais3-scenes.json')
    return { saved: true }
  })

  const downloadZip = (zip: { count: number; name: string; bytes: Uint8Array | null }): number => {
    if (zip.bytes) downloadBytes(zip.bytes, zip.name, 'application/zip')
    return zip.count
  }
  handle('scenes:exportZip', async ({ presetId }) => ({
    count: downloadZip(
      await rpcInvoke<{ count: number; name: string; bytes: Uint8Array | null }>(
        '_scenes:exportZipData',
        { presetId }
      )
    )
  }))
  handle('scenes:bulkExportZip', async ({ ids }) => ({
    count: downloadZip(
      await rpcInvoke<{ count: number; name: string; bytes: Uint8Array | null }>(
        '_scenes:bulkExportZipData',
        { ids }
      )
    )
  }))

  // 데스크톱은 폴더를 골라 001, 002… 연번으로 복사하지만 웹엔 폴더 쓰기가 없다 —
  // 같은 연번 규칙을 담은 ZIP 다운로드로 대체 (렌더러는 count만 쓰므로 UX 그대로)
  handle('library:export', async ({ ids }) => ({
    count: downloadZip(
      await rpcInvoke<{ count: number; name: string; bytes: Uint8Array | null }>(
        '_library:exportZipData',
        { ids }
      )
    )
  }))

  handle('images:saveAs', async ({ filePath }) => {
    const bytes = await rpcInvoke<Uint8Array | null>('_images:readBytes', { filePath })
    if (!bytes) return { saved: false }
    const name = filePath.startsWith('memory://')
      ? `NAIS3_${Date.now()}.png`
      : (filePath.split('/').pop() ?? 'NAIS3.png')
    downloadBytes(bytes, name, filePath.endsWith('.webp') ? 'image/webp' : 'image/png')
    return { saved: true }
  })

  handle('images:copy', async ({ filePath }) => {
    try {
      const bytes = await rpcInvoke<Uint8Array | null>('_images:readBytes', { filePath })
      if (!bytes) return { copied: false }
      // 클립보드는 PNG만 받는다 — 포맷 불문 Canvas로 PNG 재인코딩
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes).slice()]))
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) return { copied: false }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return { copied: true }
    } catch {
      return { copied: false }
    }
  })
}
