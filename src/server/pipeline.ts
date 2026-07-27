import sharp from 'sharp'
import type { GenerationRequest } from '../shared/types'
import { removeComments } from '../shared/nai-presets'
import { getNaiToken, getSetting } from '../main/db/settings'
import { processWildcards } from '../main/fragments/processor'
import { fragmentSource } from '../main/fragments/repo'
import { saveEphemeralImage, saveGeneratedImage } from '../main/images/storage'
import { broadcast } from '../main/ipc'
import { logBalance } from '../main/nai/anlas-log'
import { fetchAnlasBalance, generateImageStream, generateImageZip } from '../main/nai/client'
import { prepareCharRefs, prepareVibes } from '../main/refs/prepare'
import { getPresetName, getScene } from '../main/scenes/repo'

/**
 * 서버 생성 파이프라인 — src/main/index.ts의 GenerationQueue 콜백 이식 (웹 pipeline.ts와 동급).
 * 큐 → 조각/와일드카드 치환 → 바이브/캐릭레퍼 준비 → 스트리밍 생성 → 저장.
 * Node라 데스크톱과 달리 어댑터가 필요 없다 — sharp·fs·DB 전부 원본 모듈 그대로.
 * 치환·저장 순서와 규칙은 데스크톱과 동일하게 유지한다 (동작 차이는 곧 시드/메타데이터 재현성 버그).
 */
export async function runGeneration(
  rawRequest: GenerationRequest,
  id: string,
  signal: AbortSignal
): Promise<string> {
  const token = getNaiToken()
  if (!token) throw new Error('NAI 토큰이 설정되지 않았습니다')

  // 배치 항목마다 여기서 치환 — 매 장 다른 와일드카드 결과가 나온다.
  // 주석 제거가 반드시 먼저 (데스크톱과 동일 순서)
  const fragSource = fragmentSource()
  const sub = (text: string): string => processWildcards(removeComments(text), fragSource)
  // 3분할이면 각 조각을 개별 치환 후 병합 — 전송 프롬프트와 메타데이터(promptParts)가
  // 같은 치환 결과를 공유한다
  const subbedParts = rawRequest.promptParts
    ? {
        base: sub(rawRequest.promptParts.base),
        additional: sub(rawRequest.promptParts.additional),
        detail: sub(rawRequest.promptParts.detail)
      }
    : undefined
  let request = {
    ...rawRequest,
    prompt: subbedParts
      ? [subbedParts.base, subbedParts.additional, subbedParts.detail]
          .filter((p) => p.trim())
          .join(', ')
      : sub(rawRequest.prompt),
    negativePrompt: sub(rawRequest.negativePrompt),
    promptParts: subbedParts,
    characterPrompts: rawRequest.characterPrompts.map((c) => ({
      ...c,
      prompt: sub(c.prompt),
      negativePrompt: sub(c.negativePrompt)
    }))
  }

  // 바이브/캐릭레퍼 준비 — 요청이 id를 지정하면(출연 예약) 그것으로, 아니면 DB enabled 항목
  // (바이브는 필요 시 인코딩 — 2 Anlas, 캐시됨)
  const { vibes, newlyEncoded } = await prepareVibes(token, request.vibeIds)
  if (newlyEncoded.length) broadcast('vibes:encoded', {})
  const characterReferences = await prepareCharRefs(request.charRefIds)

  let source = request.source
  // i2i/인페인트: 소스 해상도를 유효 NAI 해상도(64 배수·픽셀 상한)로 스냅하고 이미지를 맞춰 리사이즈
  if (source) {
    const snapped = snapNaiResolution(request.width, request.height)
    if (snapped.width !== request.width || snapped.height !== request.height) {
      const resized = await sharp(Buffer.from(source.imageBase64, 'base64'))
        .resize(snapped.width, snapped.height, { fit: 'fill' })
        .png()
        .toBuffer()
      source = { ...source, imageBase64: resized.toString('base64') }
      request = { ...request, width: snapped.width, height: snapped.height }
    }
  }
  const normalizedMaskBase64 = source?.maskBase64
    ? await normalizeInpaintMask(source.maskBase64, request.width, request.height)
    : undefined
  if (source?.maskBase64 && !request.model.includes('inpainting')) {
    request = { ...request, model: `${request.model}-inpainting` }
  }

  const imageFormat: 'png' | 'webp' = getSetting('image_format') === 'webp' ? 'webp' : 'png'
  const buildOpts = {
    vibes: vibes.length > 0 ? vibes : undefined,
    characterReferences: characterReferences.length > 0 ? characterReferences : undefined,
    imageFormat,
    i2i: source
      ? {
          strength: source.strength,
          noise: source.noise,
          extraNoiseSeed: Math.max(0, request.seed - 1),
          colorCorrect: false,
          imageBase64: source.imageBase64,
          maskBase64: normalizedMaskBase64
        }
      : undefined
  }

  const streamingOn = getSetting('gen_streaming') !== '0'
  const { png, sentPayload } = !streamingOn
    ? await generateImageZip(token, request, buildOpts, signal)
    : await generateImageStream(
        token,
        request,
        buildOpts,
        (stepIx, preview) => {
          broadcast('generation:progress', {
            id,
            stepIx,
            totalSteps: request.steps,
            previewPng: preview?.toString('base64')
          })
        },
        signal
      )

  const scene = request.sceneId ? getScene(request.sceneId) : null
  const localMetadata = request.promptParts
    ? {
        promptParts: {
          ...request.promptParts,
          negative: request.negativePrompt
        }
      }
    : undefined

  // 자동저장 OFF: 메인 생성은 메모리(최근 20장)+DB 썸네일만 — 데스크톱과 동일 의미.
  // 씬 생성은 항상 씬 폴더에 저장
  const ephemeral = !scene && getSetting('auto_save') === '0'
  const saved = ephemeral
    ? await saveEphemeralImage({
        png,
        sentPayload,
        seed: request.seed,
        kind: source ? (source.maskBase64 ? 'inpaint' : 'i2i') : 't2i',
        format: imageFormat,
        localMetadata
      })
    : await saveGeneratedImage({
        png,
        sentPayload,
        seed: request.seed,
        kind: request.sceneId ? 'scene' : source ? (source.maskBase64 ? 'inpaint' : 'i2i') : 't2i',
        sceneId: request.sceneId,
        format: imageFormat,
        sceneName: scene?.name,
        scenePresetName: scene ? (getPresetName(scene.presetId) ?? undefined) : undefined,
        localMetadata
      })

  if (request.sceneId)
    broadcast('scenes:changed', { sceneId: request.sceneId, filePath: saved.filePath })

  // 생성 후 잔액 갱신 — 실패해도 생성 흐름엔 영향 없음
  void fetchAnlasBalance(token).then(({ anlas }) => {
    if (anlas !== null) {
      logBalance(anlas)
      broadcast('anlas:balance', { anlas })
    }
  })

  return saved.filePath
}

/** 소스 해상도를 유효 NAI 해상도로 스냅 — 64 배수, 픽셀 상한 내에서 비율 최대한 보존 (데스크톱 동일) */
function snapNaiResolution(w: number, h: number): { width: number; height: number } {
  const MAX_PIXELS = 1216 * 1216
  let ww = w
  let hh = h
  if (ww * hh > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (ww * hh))
    ww *= s
    hh *= s
  }
  const snap = (n: number): number => Math.max(64, Math.round(n / 64) * 64)
  return { width: snap(ww), height: snap(hh) }
}

/** NAI 인페인트 마스크 정규화 — 8×8 잠재 블록 정렬 이진화 (데스크톱 동일) */
async function normalizeInpaintMask(
  maskBase64: string,
  width: number,
  height: number
): Promise<string> {
  const mw = Math.max(1, Math.round(width / 8))
  const mh = Math.max(1, Math.round(height / 8))

  const small = await sharp(Buffer.from(stripDataUrl(maskBase64), 'base64'))
    .flatten({ background: '#000000' })
    .greyscale()
    .resize(mw, mh, { fit: 'fill' })
    .raw()
    .toBuffer()

  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(mh - 1, Math.floor(y / 8))
    for (let x = 0; x < width; x++) {
      const sx = Math.min(mw - 1, Math.floor(x / 8))
      const v = small[sy * mw + sx] > 25 ? 255 : 0
      const dst = (y * width + x) * 3
      rgb[dst] = v
      rgb[dst + 1] = v
      rgb[dst + 2] = v
    }
  }

  const png = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer()
  return png.toString('base64')
}

function stripDataUrl(base64: string): string {
  return base64.replace(/^data:[^,]+,/, '')
}
