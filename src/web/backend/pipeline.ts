import type { GenerationRequest } from '@shared/types'
import { removeComments } from '@shared/nai-presets'
import { processWildcards } from '@main/fragments/processor'
import { fragmentSource } from '@main/fragments/repo'
import { fetchAnlasBalance, generateImageStream, generateImageZip } from '@main/nai/client'
import { logBalance } from '@main/nai/anlas-log'
import { getPresetName, getScene } from '@main/scenes/repo'
import { getNaiToken, getSetting } from './db/settings'
import { normalizeInpaintMask, resizeFillPng } from './image-utils'
import { saveEphemeralImage, saveGeneratedImage } from './images/storage'
import { broadcast } from './ipc'

/**
 * 웹 생성 파이프라인 — src/main/index.ts의 GenerationQueue 콜백 이식.
 * 큐 → 조각/와일드카드 치환 → 스트리밍 생성 → 저장. 치환·저장 순서와 규칙은
 * 데스크톱과 동일하게 유지한다 (동작 차이는 곧 시드/메타데이터 재현성 버그).
 *
 * 1차 포팅 미지원: 바이브 트랜스퍼/캐릭터 레퍼런스 준비 단계 (라이브러리 포팅과 함께 후속).
 */
export async function runGeneration(
  rawRequest: GenerationRequest,
  id: string,
  signal: AbortSignal
): Promise<string> {
  const token = getNaiToken()
  if (!token) throw new Error('NAI 토큰이 설정되지 않았습니다')

  // 배치 항목마다 여기서 치환 — 매 장 다른 와일드카드 결과 (주석 제거가 반드시 먼저, 데스크톱 동일)
  const fragSource = fragmentSource()
  const sub = (text: string): string => processWildcards(removeComments(text), fragSource)
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

  let source = request.source
  // i2i/인페인트: 유효 NAI 해상도(64 배수)로 스냅 — 데스크톱과 동일 규칙 (Canvas로 리사이즈)
  if (source) {
    const snapped = snapNaiResolution(request.width, request.height)
    if (snapped.width !== request.width || snapped.height !== request.height) {
      const resized = await resizeFillPng(
        Buffer.from(source.imageBase64, 'base64'),
        snapped.width,
        snapped.height
      )
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

  void fetchAnlasBalance(token).then(({ anlas }) => {
    if (anlas !== null) {
      logBalance(anlas)
      broadcast('anlas:balance', { anlas })
    }
  })

  return saved.filePath
}

/** 소스 해상도를 유효 NAI 해상도로 스냅 — src/main/index.ts snapNaiResolution과 동일 */
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
