import type { IpcEventMap, IpcInvokeMap } from '@shared/types'
import type { GenerationQueue } from '@main/queue/generation-queue'
import { augmentImage, fetchAnlasBalance, upscaleImage, verifyToken } from '@main/nai/client'
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
import {
  collapseRefFolder,
  colorRefFolder,
  createRefFolder,
  deleteRefFolder,
  listCharRefs,
  listVibes,
  renameRefFolder,
  reorderRefs,
  updateRefImage
} from '@main/refs/repo'
import {
  createStack,
  deleteStack,
  listLibrary,
  renameStack,
  reorderImages as reorderLibraryImages,
  setStack
} from '@main/library/repo'
import {
  adjustReserveAll,
  bulkClearFavorites,
  bulkDelete,
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
import { importNais2 } from '@main/backup/nais2'
import { handleRaw } from '../bus'
import { broadcast } from '../events'
import { addRefFiles, deleteRefImageWeb } from '../backend/refs'
import { deleteImagesWeb, importBase64Web, importFilesWeb, importPathsWeb } from '../backend/library'
import {
  bulkClearImagesWeb,
  bulkExportZipData,
  deleteNonFavoritesWeb,
  exportScenesJsonData,
  exportZipData,
  importScenesJsonText
} from '../backend/scenes'
import { exportAllWeb, importAllWeb } from '../backend/backup'
import { getDb, getDbPath } from '../backend/db'
import {
  deleteNaiToken,
  getNaiToken,
  getNaiTokenInfo,
  getSetting,
  setNaiToken,
  setSetting
} from '../backend/db/settings'
import { ensureResource } from '../backend/assets'
import { imageSize, makeThumbnail } from '../backend/image-utils'
import {
  clearAllImages,
  deleteImage,
  getImagePayload,
  isWebPath,
  listImages,
  readImageBytes,
  saveGeneratedImage,
  setImageFavorite
} from '../backend/images/storage'
import {
  driveDelete,
  driveDownload,
  driveUpload,
  hasDriveToken,
  setDriveToken
} from '../backend/gdrive'
import { gdriveQueueAll } from '../backend/gdrive-store'

/**
 * 워커 채널 핸들러 — Electron 메인 프로세스의 ipc.ts에 대응 (P5에서 워커로 이동).
 * DOM이 필요한 채널(picker/다운로드/클립보드/알림/창)은 src/web/main-handlers.ts가 담당하고,
 * 파일/텍스트 데이터가 오가는 지점은 `_` 접두 내부 채널로 이쪽과 연결된다.
 * 채널 로직 자체는 M2까지의 구현을 그대로 옮긴 것 — 동작 변경 없음.
 */

function handle<C extends keyof IpcInvokeMap>(
  channel: C,
  handler: (req: IpcInvokeMap[C]['req']) => Promise<IpcInvokeMap[C]['res']> | IpcInvokeMap[C]['res']
): void {
  handleRaw(channel, handler as (req: unknown) => unknown)
}

export function registerWorkerHandlers(ctx: { dbVersion: number; queue: GenerationQueue }): void {
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

  // saveAs/copy의 데이터 소스 (다운로드/클립보드는 메인)
  handleRaw('_images:readBytes', async (req) => {
    const { filePath } = req as { filePath: string }
    if (!isWebPath(filePath)) return null
    const buf = await readImageBytes(filePath)
    return buf ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice() : null
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
  handle('settings:getSaveDir', () => ({ dir: '브라우저 내부 저장소', isDefault: true }))
  handle('settings:pickSaveDir', () => ({ dir: null }))
  handle('settings:resetSaveDir', () => ({ dir: '브라우저 내부 저장소' }))

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
  // picker는 메인 — 받은 bytes로 썸네일 생성 + BLOB 저장 (데스크톱 pickCharacterThumbnail 대응)
  handleRaw('_chars:setThumbnail', async (req) => {
    const { id, bytes } = req as { id: number; bytes: Uint8Array }
    const thumbnail = await makeThumbnail(Buffer.from(bytes))
    getDb()
      .prepare("UPDATE character_prompts SET thumbnail = ?, updated_at = datetime('now') WHERE id = ?")
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
  handleRaw('_frags:importTxts', (req) => {
    const { files } = req as { files: { name: string; text: string }[] }
    for (const f of files) createFragment(f.name.replace(/\.txt$/i, ''), null, f.text)
    return { count: files.length }
  })
  handleRaw('_frags:exportData', (req) => {
    const { id } = req as { id: number }
    const row = getDb().prepare('SELECT name, content FROM fragments WHERE id = ?').get(id) as
      | { name: string; content: string }
      | undefined
    return row ?? null
  })
  handleRaw('_frags:exportAllZip', async () => {
    const rows = getDb()
      .prepare('SELECT name, content FROM fragments ORDER BY sort_order, id')
      .all() as { name: string; content: string }[]
    if (rows.length === 0) return { count: 0, bytes: null }
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    for (const r of rows) zip.file(`${r.name.replace(/[/\\:*?"<>|]/g, '_')}.txt`, r.content)
    const blob = await zip.generateAsync({ type: 'blob' })
    return { count: rows.length, bytes: new Uint8Array(await blob.arrayBuffer()) }
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

  // ── 바이브/캐릭레퍼 (repo 재사용 + 파일 결합부만 웹 구현) ──
  handle('vibes:list', () => listVibes())
  handle('vibes:update', ({ id, patch }) => {
    updateRefImage('vibe', id, patch)
  })
  handle('vibes:delete', async ({ id }) => {
    await deleteRefImageWeb('vibe', id)
  })
  handle('vibes:reorder', ({ order }) => {
    reorderRefs('vibe', order)
  })
  handle('vibes:folderCreate', ({ name }) => ({ id: createRefFolder('vibe', name) }))
  handle('vibes:folderRename', ({ id, name }) => {
    renameRefFolder('vibe', id, name)
  })
  handle('vibes:folderCollapse', ({ id, collapsed }) => {
    collapseRefFolder('vibe', id, collapsed)
  })
  handle('vibes:folderColor', ({ id, color }) => {
    colorRefFolder('vibe', id, color)
  })
  handle('vibes:folderDelete', ({ id }) => {
    deleteRefFolder('vibe', id)
  })

  handle('crefs:list', () => listCharRefs())
  handle('crefs:update', ({ id, patch }) => {
    updateRefImage('charref', id, patch)
  })
  handle('crefs:delete', async ({ id }) => {
    await deleteRefImageWeb('charref', id)
  })
  handle('crefs:reorder', ({ order }) => {
    reorderRefs('charref', order)
  })
  handle('crefs:folderCreate', ({ name }) => ({ id: createRefFolder('charref', name) }))
  handle('crefs:folderRename', ({ id, name }) => {
    renameRefFolder('charref', id, name)
  })
  handle('crefs:folderCollapse', ({ id, collapsed }) => {
    collapseRefFolder('charref', id, collapsed)
  })
  handle('crefs:folderColor', ({ id, color }) => {
    colorRefFolder('charref', id, color)
  })
  handle('crefs:folderDelete', ({ id }) => {
    deleteRefFolder('charref', id)
  })

  handleRaw('_refs:addFiles', async (req) => {
    const { kind, folderId, files } = req as {
      kind: 'vibe' | 'charref'
      folderId: number | null
      files: { name: string; mime: string; bytes: Uint8Array }[]
    }
    return { count: await addRefFiles(kind, folderId, files) }
  })

  // ── 라이브러리 (list/stack류는 repo 재사용, 가져오기/삭제만 웹 구현) ──
  handle('library:list', ({ stackId, limit, offset }) => listLibrary(stackId, limit, offset))
  handle('library:importPaths', async ({ filePaths, stackId }) => ({
    count: await importPathsWeb(filePaths, stackId ?? null)
  }))
  handle('library:importImages', async ({ images, stackId }) => ({
    count: await importBase64Web(images, stackId ?? null)
  }))
  handle('library:delete', async ({ ids }) => {
    await deleteImagesWeb(ids)
  })
  handle('library:reorder', ({ ids }) => {
    reorderLibraryImages(ids)
  })
  handle('library:stackCreate', ({ name, imageIds }) => ({ id: createStack(name, imageIds) }))
  handle('library:stackRename', ({ id, name }) => {
    renameStack(id, name)
  })
  handle('library:stackDelete', ({ id }) => {
    deleteStack(id)
  })
  handle('library:stackSet', ({ imageIds, stackId }) => {
    setStack(imageIds, stackId)
  })
  handleRaw('_library:importFiles', async (req) => {
    const { files, stackId } = req as {
      files: { name: string; bytes: Uint8Array }[]
      stackId: number | null
    }
    return { count: await importFilesWeb(files, stackId) }
  })

  // ── 씬 ────────────────────────────────────────────────────
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
  handle('scenes:bulkDelete', ({ ids }) => {
    bulkDelete(ids)
  })
  handle('scenes:bulkClearImages', async ({ ids }) => ({
    deleted: await bulkClearImagesWeb(ids)
  }))
  handle('scenes:deleteNonFavorites', async ({ sceneId }) => ({
    deleted: await deleteNonFavoritesWeb(sceneId)
  }))
  handle('scenes:bulkSetResolution', ({ ids, width, height }) => {
    bulkSetResolution(ids, width, height)
  })
  handle('scenes:bulkClearFavorites', ({ ids }) => {
    bulkClearFavorites(ids)
  })
  handle('scenes:images', ({ sceneId, limit, offset, favoritesOnly }) =>
    sceneImages(sceneId, limit, offset, favoritesOnly)
  )
  handleRaw('_scenes:exportJsonData', (req) => {
    const { presetId } = req as { presetId: number }
    return exportScenesJsonData(presetId)
  })
  handleRaw('_scenes:importJsonText', (req) => {
    const { presetId, text } = req as { presetId: number; text: string }
    return { count: importScenesJsonText(presetId, text) }
  })
  handleRaw('_scenes:exportZipData', (req) => {
    const { presetId } = req as { presetId: number }
    return exportZipData(presetId)
  })
  handleRaw('_scenes:bulkExportZipData', (req) => {
    const { ids } = req as { ids: number[] }
    return bulkExportZipData(ids)
  })

  // ── 백업 (JSON 생성/해석은 워커, 파일 IO는 메인) ───────────
  handleRaw('_backup:exportJson', async () => JSON.stringify(await exportAllWeb()))
  handleRaw('_backup:importJson', async (req) => {
    const { text } = req as { text: string }
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      if (data._app === 'NAIS3') {
        const { imported } = await importAllWeb(data)
        return { summary: `NAIS3 백업 복원 완료 (${imported}개 항목)`, needsPromptReload: true }
      }
      if (Object.keys(data).some((k) => k.startsWith('nais2-'))) {
        const r = importNais2(data)
        const parts = [
          r.characters ? `캐릭터 ${r.characters}` : '',
          r.presets ? `프리셋 ${r.presets}` : '',
          r.fragments ? `조각 ${r.fragments}` : '',
          r.scenes ? `씬 ${r.scenes}` : '',
          r.prompt ? '프롬프트' : ''
        ].filter(Boolean)
        return {
          summary: parts.length ? `NAIS2에서 ${parts.join(' · ')} 가져옴` : '가져올 항목이 없습니다',
          needsPromptReload: r.prompt
        }
      }
      return { error: '알 수 없는 백업 형식입니다' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

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

  // ── Google Drive (P6) — 메인 GIS가 토큰 발급·주입, 워커가 REST 호출 ──
  handleRaw('_gdrive:setToken', (req) => {
    const { token, expiresAt } = req as { token: string; expiresAt: number }
    setDriveToken(token, expiresAt)
    setSetting('web_gdrive_enabled', '1')
    return { hasToken: hasDriveToken() }
  })
  handleRaw('_gdrive:clearToken', () => {
    setDriveToken(null, 0)
    setSetting('web_gdrive_enabled', '0')
  })
  handleRaw('_gdrive:status', async () => ({
    enabled: getSetting('web_gdrive_enabled') === '1',
    hasToken: hasDriveToken(),
    queueLength: (await gdriveQueueAll()).length
  }))

  // ── dev 전용 (검증 프로브) ─────────────────────────────────
  if (import.meta.env.DEV) {
    handleRaw('_dev:sql', (req) => {
      const { sql, params, mode } = req as { sql: string; params?: unknown[]; mode?: 'all' | 'run' }
      const stmt = getDb().prepare(sql)
      return mode === 'run' ? stmt.run(...(params ?? [])) : stmt.all(...(params ?? []))
    })
    // Drive 클라이언트 왕복 검증: 업로드→다운로드(내용 대조)→삭제 (실토큰 필요)
    handleRaw('_dev:gdriveSelftest', async () => {
      const path = 'web://images/_selftest/probe.txt'
      const text = 'nais3-drive-selftest'
      const uploadId = await driveUpload(path, new TextEncoder().encode(text), 'text/plain')
      const got = await driveDownload(path)
      const contentMatch = got ? new TextDecoder().decode(got) === text : false
      await driveDelete(path) // 실패 시 throw — 도달하면 원격 삭제 성공
      return { uploadId, contentMatch, deleted: true }
    })
    handleRaw('_dev:exportDb', async () => {
      const { __devDbControls } = await import('../backend/db')
      return __devDbControls.exportDb!()
    })
    handleRaw('_dev:wipeDb', async () => {
      const { __devDbControls } = await import('../backend/db')
      await __devDbControls.wipeDb!()
    })
  }

  ctx.queue.on('changed', (status) =>
    broadcast('queue:changed', status as IpcEventMap['queue:changed'])
  )
}

function refreshBalance(token: string): void {
  void fetchAnlasBalance(token).then(({ anlas }) => {
    if (anlas !== null) {
      logBalance(anlas)
      broadcast('anlas:balance', { anlas })
    }
  })
}
