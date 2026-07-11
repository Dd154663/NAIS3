import type { IpcEventMap, IpcInvokeMap } from '@shared/types'
import type { GenerationQueue } from '@main/queue/generation-queue'
import {
  augmentImage,
  fetchAnlasBalance,
  upscaleImage,
  verifyToken
} from '@main/nai/client'
import { anlasUsage, logBalance } from '@main/nai/anlas-log'
import { countTokens } from '@main/nai/tokenizer'
import { searchTags } from '@main/tags'
import {
  clearCharacterThumbnail,
  createCharacter,
  createFolder,
  deleteCharacter,
  deleteFolder,
  duplicateCharacter,
  listCharacters,
  renameFolder,
  reorderCharacters,
  setFolderCollapsed,
  setFolderColor,
  updateCharacter
} from '@main/characters/repo'
import {
  createFragment,
  createFragmentFolder,
  deleteFragment,
  deleteFragmentFolder,
  duplicateFragment,
  fragmentSource,
  listFragments,
  renameFragmentFolder,
  reorderFragments,
  setFragmentFolderCollapsed,
  setFragmentFolderColor,
  updateFragment
} from '@main/fragments/repo'
import { processWildcards, resetSequentialCounters } from '@main/fragments/processor'
import { removeComments } from '@shared/nai-presets'
import {
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  reorderPromptPresets,
  updatePromptPreset
} from '@main/prompts/repo'
import { listCharRefs, listVibes } from '@main/refs/repo'
import { listLibrary } from '@main/library/repo'
import {
  adjustReserveAll,
  bulkClearFavorites,
  bulkMove,
  bulkSetResolution,
  createPreset,
  createScene,
  deletePreset,
  deleteScene,
  duplicateScene,
  getScene,
  listPresets,
  listScenes,
  renamePreset,
  reorderPresets,
  reorderScenes,
  sceneImages,
  setPresetDefaultResolution,
  setReserveAll,
  updateScene
} from '@main/scenes/repo'
import { metadataFromPayloadJson, metadataFromPng } from '@main/images/metadata'
import { getDb, getDbPath } from './db'
import {
  deleteNaiToken,
  getNaiToken,
  getNaiTokenInfo,
  getSetting,
  setNaiToken,
  setSetting
} from './db/settings'
import { ensureResource } from './assets'
import { downloadBytes, imageSize, makeThumbnail, pickFiles } from './image-utils'
import {
  clearAllImages,
  deleteImage,
  getImagePayload,
  isWebPath,
  listImages,
  readImageBytes,
  saveGeneratedImage,
  setImageFavorite
} from './images/storage'

/**
 * 웹 invoke 라우터 — Electron ipcMain.handle의 웹 대응.
 * 채널 등록 목록은 src/main/ipc.ts를 미러링하되, 웹에서 의미가 다른 것만 대체 구현한다.
 * 미등록 채널은 명확한 에러로 reject — 조용한 오동작보다 표면화가 낫다 (부팅 경로는
 * 렌더러가 Promise.allSettled로 감싸므로 안전).
 */

type AnyHandler = (req: unknown) => unknown

const handlers = new Map<string, AnyHandler>()

function handle<C extends keyof IpcInvokeMap>(
  channel: C,
  handler: (req: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']
): void {
  handlers.set(channel, handler as AnyHandler)
}

export function invoke<C extends keyof IpcInvokeMap>(
  channel: C,
  req: IpcInvokeMap[C]['req']
): Promise<IpcInvokeMap[C]['res']> {
  const h = handlers.get(channel)
  if (!h) return Promise.reject(new Error(`[web] 미구현 채널: ${channel}`))
  try {
    return Promise.resolve(h(req) as IpcInvokeMap[C]['res'])
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

const listeners = new Map<string, Set<(payload: unknown) => void>>()

export function on<C extends keyof IpcEventMap>(
  channel: C,
  listener: (payload: IpcEventMap[C]) => void
): () => void {
  if (!listeners.has(channel)) listeners.set(channel, new Set())
  const set = listeners.get(channel)!
  set.add(listener as (payload: unknown) => void)
  return () => set.delete(listener as (payload: unknown) => void)
}

export function broadcast<C extends keyof IpcEventMap>(channel: C, payload: IpcEventMap[C]): void {
  // ipcRenderer 이벤트처럼 비동기 디스패치 — 호출 스택과 분리
  queueMicrotask(() => {
    for (const fn of listeners.get(channel) ?? []) fn(payload)
  })
}

export function registerWebHandlers(ctx: { dbVersion: number; queue: GenerationQueue }): void {
  handle('db:status', () => ({ version: ctx.dbVersion, path: getDbPath() }))
  handle('app:version', () => ({ version: __APP_VERSION__ }))

  // ── NAI 토큰/잔액 ─────────────────────────────────────────
  handle('nai:verifyToken', ({ token }) => verifyToken(token))
  handle('nai:setToken', async ({ token }) => {
    const result = await verifyToken(token)
    if (result.valid) setNaiToken(token)
    return result
  })
  handle('nai:tokenStatus', () => getNaiTokenInfo())
  handle('nai:revealToken', () => ({ token: getNaiToken() }))
  handle('nai:deleteToken', () => {
    deleteNaiToken()
  })
  handle('nai:balance', async () => {
    const token = getNaiToken()
    if (!token) return { anlas: null, tier: null }
    const { anlas, tier } = await fetchAnlasBalance(token)
    if (anlas !== null) logBalance(anlas)
    return { anlas, tier }
  })
  handle('nai:anlasUsage', () => anlasUsage())

  // ── 생성 큐 ──────────────────────────────────────────────
  handle('queue:enqueue', ({ request, count }) => ({ ids: ctx.queue.enqueue(request, count) }))
  handle('queue:cancel', ({ ids }) => {
    ctx.queue.cancel(ids)
  })
  handle('queue:status', () => ctx.queue.status())
  handle('gen:setDelay', ({ ms }) => {
    ctx.queue.setDelayMs(ms)
    setSetting('gen_delay_ms', String(ms))
  })

  // ── 히스토리/이미지 ───────────────────────────────────────
  handle('images:list', ({ limit, offset }) => listImages(limit, offset))
  handle('images:payload', ({ id }) => ({ payloadJson: getImagePayload(id) }))
  handle('images:setFavorite', ({ id, favorite }) => {
    setImageFavorite(id, favorite)
  })
  handle('images:delete', async ({ id }) => {
    // 웹은 파일 보존 개념이 없어 deleteFile 여부와 무관하게 blob까지 정리 (storage.ts 참조)
    await deleteImage(id)
  })
  handle('images:clearAll', async () => ({ count: await clearAllImages() }))

  handle('images:readForSource', async ({ filePath }) => {
    if (!isWebPath(filePath)) return { error: '허용되지 않은 경로' }
    const buf = await readImageBytes(filePath)
    if (!buf) return { error: '원본이 만료되었습니다 (자동저장 꺼짐 상태로 생성된 이미지)' }
    const { width, height } = await imageSize(buf)
    return { base64: buf.toString('base64'), width, height }
  })

  handle('images:saveAs', async ({ filePath }) => {
    const buf = await readImageBytes(filePath)
    if (!buf) return { saved: false }
    const name = filePath.startsWith('memory://')
      ? `NAIS3_${Date.now()}.png`
      : (filePath.split('/').pop() ?? 'NAIS3.png')
    downloadBytes(buf, name, filePath.endsWith('.webp') ? 'image/webp' : 'image/png')
    return { saved: true }
  })

  handle('images:copy', async ({ filePath }) => {
    try {
      const buf = await readImageBytes(filePath)
      if (!buf) return { copied: false }
      // 클립보드는 PNG만 받는다 — 포맷 불문 Canvas로 PNG 재인코딩
      const bmp = await createImageBitmap(new Blob([new Uint8Array(buf).slice()]))
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

  handle('images:saveLocal', async ({ base64, kind }) => {
    try {
      const png = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ local: kind }),
        seed: 0,
        kind
      })
      return { filePath: saved.filePath }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:upscale', async ({ imageBase64, scale }) => {
    const token = getNaiToken()
    if (!token) return { error: 'NAI 토큰이 설정되지 않았습니다' }
    try {
      const input = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
      const { width, height } = await imageSize(input)
      const png = await upscaleImage(token, {
        imageBase64: input.toString('base64'),
        width,
        height,
        scale
      })
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ upscale: scale }),
        seed: 0,
        kind: 'upscale'
      })
      refreshBalance(token)
      return { filePath: saved.filePath, base64: png.toString('base64') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('director:run', async ({ method, imageBase64, prompt, defry }) => {
    const token = getNaiToken()
    if (!token) return { error: 'NAI 토큰이 설정되지 않았습니다' }
    try {
      const input = Buffer.from(imageBase64.replace(/^data:[^,]+,/, ''), 'base64')
      const { width, height } = await imageSize(input)
      const png = await augmentImage(token, {
        method,
        imageBase64: input.toString('base64'),
        width,
        height,
        prompt,
        defry
      })
      const saved = await saveGeneratedImage({
        png,
        sentPayload: JSON.stringify({ director: method, prompt, defry }),
        seed: 0,
        kind: method
      })
      refreshBalance(token)
      return { filePath: saved.filePath, base64: png.toString('base64') }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('images:readMetadata', async ({ filePath, base64 }) => {
    try {
      if (base64) {
        const buf = Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
        const meta = await metadataFromPng(buf)
        return meta ? { meta } : { error: '이 이미지에서 NAI 메타데이터를 찾지 못했습니다' }
      }
      if (filePath) {
        if (!isWebPath(filePath)) return { error: '허용되지 않은 경로' }
        const row = getDb()
          .prepare('SELECT payload_json FROM images WHERE file_path = ?')
          .get(filePath) as { payload_json: string } | undefined
        const fromDb = row?.payload_json ? metadataFromPayloadJson(row.payload_json) : null
        const buf = await readImageBytes(filePath)
        if (!buf) {
          if (fromDb) return { meta: fromDb }
          return { error: '원본이 만료되었습니다 (자동저장 꺼짐 상태로 생성된 이미지)' }
        }
        // 스텔스(zlib/sharp) 경로는 웹 미지원 — tEXt 파싱 실패 시 DB payload로 폴백
        const fromPng = await metadataFromPng(buf).catch(() => null)
        if (fromPng) {
          return {
            meta:
              !fromPng.promptParts && fromDb?.promptParts
                ? { ...fromPng, promptParts: fromDb.promptParts }
                : fromPng
          }
        }
        if (fromDb) return { meta: fromDb }
        return { error: '메타데이터를 찾지 못했습니다' }
      }
      return { error: '입력이 없습니다' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── 설정 ─────────────────────────────────────────────────
  handle('settings:get', ({ key }) => ({ value: getSetting(key) }))
  handle('settings:set', ({ key, value }) => {
    setSetting(key, value)
  })
  // 웹은 저장 위치가 브라우저 내부로 고정 — 폴더 선택 개념이 없다
  handle('settings:getSaveDir', () => ({ dir: '브라우저 내부 저장소 (IndexedDB)', isDefault: true }))
  handle('settings:pickSaveDir', () => ({ dir: null }))
  handle('settings:resetSaveDir', () => ({ dir: '브라우저 내부 저장소 (IndexedDB)' }))

  // ── 데스크톱 전용 — 웹에선 no-op ─────────────────────────
  handle('window:control', () => {})
  handle('window:setBackground', ({ color }) => {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
      document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.setAttribute('content', color)
      document.documentElement.style.backgroundColor = color
    }
  })
  handle('update:start', () => {})
  handle('images:showInFolder', () => {})

  handle('notify:done', ({ done, failed }) => {
    if (!document.hidden) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const body = failed > 0 ? `${done}장 완료 · ${failed}장 실패` : `${done}장 완료`
    new Notification('NAIS3 생성 완료', { body, silent: true })
  })

  // ── 캐릭터 (repo 재사용 — 순수 SQL) ───────────────────────
  handle('chars:list', () => listCharacters())
  handle('chars:create', ({ name, folderId }) => ({ id: createCharacter(name, folderId) }))
  handle('chars:update', ({ id, patch }) => {
    updateCharacter(id, patch)
  })
  handle('chars:delete', ({ id }) => {
    deleteCharacter(id)
  })
  handle('chars:duplicate', ({ id }) => ({ id: duplicateCharacter(id) }))
  handle('chars:clearThumbnail', ({ id }) => {
    clearCharacterThumbnail(id)
  })
  handle('chars:reorder', ({ order }) => {
    reorderCharacters(order)
  })
  handle('chars:folderCreate', ({ name }) => ({ id: createFolder(name) }))
  handle('chars:folderRename', ({ id, name }) => {
    renameFolder(id, name)
  })
  handle('chars:folderCollapse', ({ id, collapsed }) => {
    setFolderCollapsed(id, collapsed)
  })
  handle('chars:folderColor', ({ id, color }) => {
    setFolderColor(id, color)
  })
  handle('chars:folderDelete', ({ id }) => {
    deleteFolder(id)
  })
  // 데스크톱은 파일 다이얼로그+sharp — 웹은 파일 picker + Canvas
  handle('chars:pickThumbnail', async ({ id }) => {
    const [file] = await pickFiles('image/*', false)
    if (!file) return { thumbnail: null }
    const thumbnail = await makeThumbnail(Buffer.from(await file.arrayBuffer()))
    getDb()
      .prepare('UPDATE character_prompts SET thumbnail = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(thumbnail, id)
    return { thumbnail: thumbnail.toString('base64') }
  })

  // ── 조각 (repo 재사용) ────────────────────────────────────
  handle('frags:list', () => listFragments())
  handle('frags:create', ({ name, folderId }) => ({ id: createFragment(name, folderId) }))
  handle('frags:update', ({ id, patch }) => {
    updateFragment(id, patch)
  })
  handle('frags:delete', ({ id }) => {
    deleteFragment(id)
  })
  handle('frags:duplicate', ({ id }) => ({ id: duplicateFragment(id) }))
  handle('frags:resetSequential', () => {
    resetSequentialCounters()
  })
  handle('frags:reorder', ({ order }) => {
    reorderFragments(order)
  })
  handle('frags:folderCreate', ({ name }) => ({ id: createFragmentFolder(name) }))
  handle('frags:folderRename', ({ id, name }) => {
    renameFragmentFolder(id, name)
  })
  handle('frags:folderCollapse', ({ id, collapsed }) => {
    setFragmentFolderCollapsed(id, collapsed)
  })
  handle('frags:folderColor', ({ id, color }) => {
    setFragmentFolderColor(id, color)
  })
  handle('frags:folderDelete', ({ id }) => {
    deleteFragmentFolder(id)
  })
  // 데스크톱은 파일 다이얼로그 — 웹은 picker/다운로드로 동일 기능 제공
  handle('frags:importTxt', async () => {
    const files = await pickFiles('.txt,text/plain', true)
    let count = 0
    for (const f of files) {
      const name = f.name.replace(/\.txt$/i, '')
      createFragment(name, null, await f.text())
      count++
    }
    return { count }
  })
  handle('frags:exportTxt', ({ id }) => {
    const row = getDb().prepare('SELECT name, content FROM fragments WHERE id = ?').get(id) as
      | { name: string; content: string }
      | undefined
    if (!row) return { saved: false }
    downloadBytes(new Blob([row.content], { type: 'text/plain' }), `${row.name}.txt`)
    return { saved: true }
  })
  handle('frags:exportAll', async () => {
    const rows = getDb().prepare('SELECT name, content FROM fragments ORDER BY sort_order, id').all() as {
      name: string
      content: string
    }[]
    if (rows.length === 0) return { count: 0 }
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    for (const r of rows) zip.file(`${r.name.replace(/[/\\:*?"<>|]/g, '_')}.txt`, r.content)
    downloadBytes(await zip.generateAsync({ type: 'blob' }), 'NAIS3-fragments.zip')
    return { count: rows.length }
  })

  // ── 프롬프트 프리셋 (repo 재사용) ──────────────────────────
  handle('promptPresets:list', () => ({ items: listPromptPresets() }))
  handle('promptPresets:create', ({ name, prompt, negativePrompt, params }) => ({
    id: createPromptPreset(name, prompt, negativePrompt, params)
  }))
  handle('promptPresets:update', ({ id, patch }) => {
    updatePromptPreset(id, patch)
  })
  handle('promptPresets:delete', ({ id }) => {
    deletePromptPreset(id)
  })
  handle('promptPresets:reorder', ({ ids }) => {
    reorderPromptPresets(ids)
  })

  // ── 바이브/캐릭레퍼/라이브러리 — 1차는 목록만 (생성 파이프라인 연동은 후속) ──
  handle('vibes:list', () => listVibes())
  handle('crefs:list', () => listCharRefs())
  handle('library:list', ({ stackId, limit, offset }) => listLibrary(stackId, limit, offset))

  // ── 씬 (repo 재사용 — 파일 I/O 없는 채널만) ────────────────
  handle('scenePresets:list', () => ({ items: listPresets() }))
  handle('scenePresets:create', ({ name }) => ({ id: createPreset(name) }))
  handle('scenePresets:rename', ({ id, name }) => {
    renamePreset(id, name)
  })
  handle('scenePresets:delete', ({ id }) => {
    deletePreset(id)
  })
  handle('scenePresets:reorder', ({ ids }) => {
    reorderPresets(ids)
  })
  handle('scenePresets:setDefaultResolution', ({ id, width, height }) => {
    setPresetDefaultResolution(id, width, height)
  })
  handle('scenes:list', ({ presetId }) => ({ items: listScenes(presetId) }))
  handle('scenes:create', ({ presetId, name }) => ({ id: createScene(presetId, name) }))
  handle('scenes:get', ({ id }) => ({ scene: getScene(id) }))
  handle('scenes:update', ({ id, patch }) => {
    updateScene(id, patch)
  })
  handle('scenes:duplicate', ({ id }) => ({ id: duplicateScene(id) }))
  handle('scenes:delete', ({ id }) => {
    deleteScene(id)
  })
  handle('scenes:reorder', ({ ids }) => {
    reorderScenes(ids)
  })
  handle('scenes:setReserveAll', ({ presetId, count }) => {
    setReserveAll(presetId, count)
  })
  handle('scenes:adjustReserveAll', ({ presetId, delta }) => {
    adjustReserveAll(presetId, delta)
  })
  handle('scenes:bulkMove', ({ ids, presetId }) => {
    bulkMove(ids, presetId)
  })
  handle('scenes:bulkSetResolution', ({ ids, width, height }) => {
    bulkSetResolution(ids, width, height)
  })
  handle('scenes:bulkClearFavorites', ({ ids }) => {
    bulkClearFavorites(ids)
  })
  handle('scenes:images', ({ sceneId, limit, offset, favoritesOnly }) =>
    sceneImages(sceneId, limit, offset, favoritesOnly)
  )
  handle('scenes:openFolder', () => ({ ok: false }))

  // ── 태그/토큰 (리소스 지연 로드 후 원본 로직 재사용) ─────────
  handle('tags:search', async ({ query, limit }) => {
    await ensureResource('tags.json')
    return { items: searchTags(query, limit) }
  })
  handle('tokens:count', async ({ texts }) => {
    await ensureResource('t5_tokenizer.json')
    const src = fragmentSource()
    return {
      counts: texts.map((t) => countTokens(processWildcards(removeComments(t), src, () => 0, true)))
    }
  })

  ctx.queue.on('changed', (status) => broadcast('queue:changed', status as IpcEventMap['queue:changed']))
}

function refreshBalance(token: string): void {
  void fetchAnlasBalance(token).then(({ anlas }) => {
    if (anlas !== null) {
      logBalance(anlas)
      broadcast('anlas:balance', { anlas })
    }
  })
}
